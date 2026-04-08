const Orchestrator = class {
  constructor(db, openai, sendEvent) {
    this.db = db;
    this.openai = openai;
    this.sendEvent = sendEvent || (() => {});
  }

  log(msg) {
    console.log(msg);
    this.sendEvent('log', msg);
  }

  async extractIntent(prompt) {
    this.log(`Primary Agent extracting intent from: "${prompt}"`);
    const resp = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Extract the core tool capability the user is requesting (e.g. "web search", "email sending", "image generation"). Return JSON object with exactly one key "intent" containing your extracted requirement as a string.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    });
    return JSON.parse(resp.choices[0].message.content).intent;
  }

  async getMatchedIntentCache(prompt) {
    const rawIntent = await this.extractIntent(prompt);
    
    const existingCaches = this.db.prepare('SELECT intent FROM intent_cache').all().map(r => r.intent);
    
    let matchedIntent = null;
    if (existingCaches.length > 0) {
      this.log(`Checking semantic match against ${existingCaches.length} cached intents...`);
      const resp = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are an intent matcher. Given a user goal and a list of cached intents (strings), tell me if any cached intent semantically covers the user goal. If yes, return exactly JSON: {"matched_intent": "exact string from list"}. If no match, return {"matched_intent": null}.' },
          { role: 'user', content: `Goal: ${rawIntent}\nCached Intents: ${JSON.stringify(existingCaches)}` }
        ],
        response_format: { type: 'json_object' }
      });
      matchedIntent = JSON.parse(resp.choices[0].message.content).matched_intent;
    }

    const total_tools = this.db.prepare('SELECT COUNT(*) as count FROM tools').get().count;

    if (matchedIntent && existingCaches.includes(matchedIntent)) {
      this.log(`Cache HIT for intent: "${matchedIntent}"`);
      const row = this.db.prepare('SELECT * FROM intent_cache WHERE intent = ?').get(matchedIntent);
      return {
        intent: matchedIntent,
        main_list: JSON.parse(row.main_list || '[]'),
        audition_queue: JSON.parse(row.audition_queue || '[]'),
        last_processed_log_id: row.last_processed_log_id,
        last_scanned_tool_id: row.last_scanned_tool_id || 0,
        total_tools_rows: total_tools,
        isNew: false
      };
    } else {
      this.log(`Cache MISS. Initializing new cache for intent: "${rawIntent}"`);
      const newCache = {
        intent: rawIntent,
        main_list: [],
        audition_queue: [],
        last_processed_log_id: 0,
        last_scanned_tool_id: 0,
        total_tools_rows: total_tools,
        isNew: true
      };
      
      this.db.prepare(`INSERT INTO intent_cache 
        (intent, main_list, audition_queue, last_processed_log_id, last_scanned_tool_id, total_tools_rows) 
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        rawIntent, JSON.stringify([]), JSON.stringify([]), 0, 0, total_tools
      );
      return newCache;
    }
  }

  async applyActivityLog(cacheState) {
    this.log(`Checking tool activity log for intent "${cacheState.intent}" since log ID ${cacheState.last_processed_log_id}...`);
    const logs = this.db.prepare('SELECT * FROM tool_activity_log WHERE id > ? ORDER BY id ASC').all(cacheState.last_processed_log_id);
    
    if (logs.length === 0) {
      this.log('No new relevant tool activity found.');
      return cacheState;
    }

    let nextLogId = cacheState.last_processed_log_id;
    let mainSet = new Set(cacheState.main_list);
    let auditionSet = new Set(cacheState.audition_queue);

    const toolUpdates = new Map();
    for (const log of logs) {
      toolUpdates.set(log.tool_id, log.action);
      nextLogId = log.id;
    }

    for (const [tool_id, action] of toolUpdates.entries()) {
      if (action === 'DELETE') {
        mainSet.delete(tool_id);
        auditionSet.delete(tool_id);
        continue;
      }
      
      const tool = this.db.prepare('SELECT * FROM tools WHERE id = ?').get(tool_id);
      if (!tool) continue;

      if (action === 'UPDATE' && (mainSet.has(tool_id) || auditionSet.has(tool_id))) {
        this.log(`Existing tool ${tool_id} was updated. Moving to audition queue.`);
        mainSet.delete(tool_id);
        auditionSet.add(tool_id);
      } else if (action === 'INSERT' || action === 'UPDATE') {
        // IGNORE INSERTS if tool_id is greater than last_scanned_tool_id!
        // The JIT scanner will organically catch it when it reaches that ID.
        if (action === 'INSERT' && tool_id > cacheState.last_scanned_tool_id) {
           this.log(`Skipping activity log check for newly created tool ${tool_id} because it's beyond the JIT horizon. Will lazy-load later.`);
           continue;
        }

        if (!mainSet.has(tool_id) && !auditionSet.has(tool_id)) {
           // Gatekeep older tools that were updated or caught somehow
           this.log(`Gatekeeper: Scanning updated tool ${tool_id} against intent "${cacheState.intent}"`);
           try {
             const resp = await this.openai.chat.completions.create({
               model: 'gpt-4o-mini',
               messages: [
                 { role: 'system', content: `Is this tool potentially relevant to fulfilling this user goal? Be moderately permissive but reject totally unrelated tools. Return exactly JSON: { "relevant": true } or { "relevant": false }` },
                 { role: 'user', content: `Goal: ${cacheState.intent}\nTool:\nName: ${tool.name}\nDescription: ${tool.description}` }
               ],
               response_format: { type: 'json_object' }
             });
             const isRelevant = JSON.parse(resp.choices[0].message.content).relevant;
             
             if (isRelevant) {
               this.log(`Gatekeeper accepted tool ${tool_id} into audition queue.`);
               auditionSet.add(tool_id);
             } else {
               this.log(`Gatekeeper rejected tool ${tool_id}.`);
             }
           } catch (e) {
              this.log(`Error during gatekeeper evaluation: ${e.message}`);
           }
        }
      }
    }

    cacheState.main_list = Array.from(mainSet);
    cacheState.audition_queue = Array.from(auditionSet);
    cacheState.last_processed_log_id = nextLogId;

    this.saveCache(cacheState);
    return cacheState;
  }

  saveCache(state) {
    this.db.prepare(`UPDATE intent_cache 
      SET main_list = ?, audition_queue = ?, last_processed_log_id = ?, last_scanned_tool_id = ?, total_tools_rows = ? 
      WHERE intent = ?`).run(
      JSON.stringify(state.main_list),
      JSON.stringify(state.audition_queue),
      state.last_processed_log_id,
      state.last_scanned_tool_id || 0,
      state.total_tools_rows || 0,
      state.intent
    );
  }

  async buildAndEvaluateBatches(objective, cacheState, resumeMainIndex = 0, resumeAuditionIndex = 0) {
     this.log(`Starting Orchestrator JIT loop...`);
     
     let mainIndex = resumeMainIndex;
     let auditionIndex = resumeAuditionIndex;

     while (true) {
       // --- JIT CACHE REPLENISHMENT ---
       let needsMoreCandidates = (mainIndex >= cacheState.main_list.length && auditionIndex >= cacheState.audition_queue.length);
       
       if (needsMoreCandidates) {
          const highestDbToolRow = this.db.prepare('SELECT MAX(id) as maxId FROM tools').get();
          const highestDbToolId = highestDbToolRow ? (highestDbToolRow.maxId || 0) : 0;
          
          if (cacheState.last_scanned_tool_id < highestDbToolId) {
             this.log(`Lists exhausted. Waking Gatekeeper to lazy-load up to 5 more relevant tools...`);
             let addedCount = 0;
             let scanId = cacheState.last_scanned_tool_id;

             while (addedCount < 1 && scanId < highestDbToolId) {
                const nextChunk = this.db.prepare('SELECT * FROM tools WHERE id > ? ORDER BY id ASC LIMIT 10').all(scanId);
                if (nextChunk.length === 0) break;

                for (const tool of nextChunk) {
                   scanId = tool.id;
                   
                   this.log(`Gatekeeper scanning Tool ${tool.id} (${tool.name})`);
                   try {
                     const resp = await this.openai.chat.completions.create({
                       model: 'gpt-4o-mini',
                       messages: [
                         { role: 'system', content: `Is this tool potentially relevant to fulfilling this user goal? Be moderately permissive but reject totally unrelated tools. Return exactly JSON: { "relevant": true } or { "relevant": false }` },
                         { role: 'user', content: `Goal: ${cacheState.intent}\nTool:\nName: ${tool.name}\nDescription: ${tool.description}` }
                       ],
                       response_format: { type: 'json_object' }
                     });
                     
                     if (JSON.parse(resp.choices[0].message.content).relevant) {
                       this.log(`Gatekeeper accepted tool ${tool.id}! Adding to audition queue.`);
                       cacheState.audition_queue.push(tool.id);
                       addedCount++;
                     } else {
                       this.log(`Gatekeeper rejected tool ${tool.id} (irrelevant).`);
                     }
                   } catch (e) {
                     this.log(`Gatekeeper error on tool ${tool.id}: ${e.message}`);
                   }
                   
                   if (addedCount >= 1) {
                      scanId = tool.id; // Pause scan exactly here
                      break;
                   }
                }
             }
             
             // Save the JIT progress
             cacheState.last_scanned_tool_id = scanId;
             const totalToolsRightNow = this.db.prepare('SELECT COUNT(*) as count FROM tools').get().count;
             cacheState.total_tools_rows = totalToolsRightNow;
             this.saveCache(cacheState);
             
             if (addedCount === 0) {
                 this.log(`Gatekeeper scanned remaining database but found no relevant tools.`);
                 break; // Entire database scanned, none relevant.
             }
          } else {
             break; // We have exhausted both the lists AND the entire database!
          }
       }

       // --- BATCH COMPOSITION ---
       let batchIds = [];
       // Take up to 4 from main
       while(batchIds.length < 4 && mainIndex < cacheState.main_list.length) {
         batchIds.push(cacheState.main_list[mainIndex]);
         mainIndex++;
       }
       // Take 1 from audition
       if (auditionIndex < cacheState.audition_queue.length && batchIds.length < 5) {
         batchIds.push(cacheState.audition_queue[auditionIndex]);
         auditionIndex++;
       }

       if (batchIds.length === 0) break; // Should not trigger unless completely empty

       const batchTools = batchIds.map(id => this.db.prepare('SELECT id, name, description FROM tools WHERE id = ?').get(id));
       
       this.log(`Evaluating batch of ${batchTools.length} candidates...`);
       
       try {
         const resp = await this.openai.chat.completions.create({
           model: 'gpt-4o-mini',
           messages: [
             { role: 'system', content: `You are an Orchestrator. Given a user goal and a batch of tools, pick the ONE BEST tool that fits the goal. Ignore unhelpful tools. Return exactly JSON: { "selected_tool_id": <id> } or { "selected_tool_id": null } if no tool is suitable.`},
             { role: 'user', content: `Goal: ${objective}\nTools: ${JSON.stringify(batchTools)}` }
           ],
           response_format: { type: 'json_object' }
         });
         
         let selectedToolId = JSON.parse(resp.choices[0].message.content).selected_tool_id;

         if (selectedToolId) {
           this.log(`Orchestrator selected best candidate: tool ${selectedToolId}. Halting for User verification.`);
           return {
             objective,
             intent: cacheState.intent,
             batchIds: batchIds,
             batchTools: batchTools,
             selectedToolId: selectedToolId,
             nextMainIndex: mainIndex,
             nextAuditionIndex: auditionIndex,
             exhausted: false
           };
         } else {
           this.log(`Orchestrator rejected all tools in batch. Loop will fetch next batch...`);
         }
       } catch (e) {
           this.log(`Error evaluating batch: ${e.message}`);
       }
     }

     this.log(`Orchestrator exhausted all candidates and entire database. No suitable tool found.`);
     return { objective, intent: cacheState.intent, exhausted: true };
  }

  applyFeedback(intent, objective, batchIds, selectedToolId, isBestMatch) {
    const cacheRow = this.db.prepare('SELECT * FROM intent_cache WHERE intent = ?').get(intent);
    if (!cacheRow) {
      console.log('Cache row not found.');
      return;
    }

    let main_list = JSON.parse(cacheRow.main_list || '[]');
    let audition_queue = JSON.parse(cacheRow.audition_queue || '[]');

    if (isBestMatch) {
      // SUCCESS: Promote selected tool
      if (audition_queue.includes(selectedToolId)) {
        audition_queue = audition_queue.filter(id => id !== selectedToolId);
        main_list.unshift(selectedToolId); // promote to rank 0
      } else {
        const idx = main_list.indexOf(selectedToolId);
        if (idx > 0) {
          // shift rank up by 1
          const temp = main_list[idx - 1];
          main_list[idx - 1] = main_list[idx];
          main_list[idx] = temp;
        }
      }

      // Demote others in batch
      for (const id of batchIds) {
        if (id === selectedToolId) continue;
        if (main_list.includes(id)) {
           const idx = main_list.indexOf(id);
           if (idx !== -1 && idx < main_list.length - 1) {
             // shift 1 spot down
             const temp = main_list[idx + 1];
             main_list[idx + 1] = main_list[idx];
             main_list[idx] = temp;
           }
        }
      }
      this.log(`Successfully updated cache rankings based on positive user feedback.`);
    } else {
      // FAILURE: Demote selected tool
      if (main_list.includes(selectedToolId)) {
         const idx = main_list.indexOf(selectedToolId);
         if (idx !== -1 && idx < main_list.length - 1) {
             const temp = main_list[idx + 1];
             main_list[idx + 1] = main_list[idx];
             main_list[idx] = temp;
         }
      } else if (audition_queue.includes(selectedToolId)) {
         // Cycle down to bottom of audition queue (penalize exposure)
         audition_queue = audition_queue.filter(id => id !== selectedToolId);
         audition_queue.push(selectedToolId);
      }
      this.log(`Demoted tool based on negative user feedback.`);
    }

    this.saveCache({ 
      intent, 
      main_list, 
      audition_queue, 
      last_processed_log_id: cacheRow.last_processed_log_id,
      last_scanned_tool_id: cacheRow.last_scanned_tool_id,
      total_tools_rows: cacheRow.total_tools_rows
    });

    try {
        this.db.prepare('INSERT INTO resolution_ledger (objective, evaluated_batch, selected_tool_id, user_feedback) VALUES (?, ?, ?, ?)').run(
          objective,
          JSON.stringify(batchIds),
          selectedToolId,
          isBestMatch ? 'Agree' : 'Disagree'
        );
        this.log('Logged resolution to ledger.');
    } catch(e) {
        console.error('Ledger insert failed', e);
    }
  }
}

module.exports = Orchestrator;
