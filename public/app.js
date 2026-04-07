document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('prompt-form');
  const promptInput = document.getElementById('prompt-input');
  const submitBtn = document.getElementById('submit-btn');
  const btnText = submitBtn.querySelector('.btn-text');
  const loaderSpinner = submitBtn.querySelector('.loader-spinner');
  
  const resultsSection = document.getElementById('results-section');
  const logsWindow = document.getElementById('logs-window');
  const selectionArea = document.getElementById('selection-area');
  const matchStatusLabel = document.getElementById('match-status');
  
  const feedbackActions = document.getElementById('feedback-actions');
  const btnAgree = document.getElementById('btn-agree');
  const btnDisagree = document.getElementById('btn-disagree');

  let activeStreamSource = null;
  let currentSelectionState = null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const prompt = promptInput.value.trim();
    if (!prompt) return;

    // UI Reset
    btnText.style.display = 'none';
    loaderSpinner.style.display = 'block';
    submitBtn.disabled = true;
    resultsSection.style.display = 'grid';
    logsWindow.innerHTML = '';
    selectionArea.innerHTML = '';
    matchStatusLabel.textContent = 'Orchestrator searching...';
    feedbackActions.style.display = 'none';

    startOrchestratorPhase({ prompt });
  });

  function startOrchestratorPhase(params) {
    if (activeStreamSource) {
      activeStreamSource.close();
    }

    loaderSpinner.style.display = 'block';

    try {
      activeStreamSource = new EventSource('/api/stream');
      
      activeStreamSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'connected') {
          const payload = { streamId: data.id, ...params };
          fetch('/api/orchestrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }).catch(err => {
            appendLog('Error querying server: ' + err.message, true);
            restoreBtn();
          });
        }
        else if (data.type === 'log') {
          appendLog(data.payload);
        }
        else if (data.type === 'selection') {
          currentSelectionState = data.payload;
          renderSelection(currentSelectionState);
          activeStreamSource.close();
          loaderSpinner.style.display = 'none';
        }
        else if (data.type === 'exhausted') {
          appendLog(`[SYSTEM] Orchestrator exhausted candidate list.`);
          matchStatusLabel.textContent = `No tools found in cache.`;
          selectionArea.innerHTML = `<p style="color: #94a3b8;">No suitable capability found. Try a different request or add a new tool.</p>`;
          activeStreamSource.close();
          restoreBtn();
        }
        else if (data.type === 'error') {
          appendLog(`[ERROR] ${data.payload}`, true);
          activeStreamSource.close();
          restoreBtn();
        }
      };

      activeStreamSource.onerror = (err) => {
        console.error("SSE Error:", err);
        restoreBtn();
      };
    } catch (error) {
      appendLog('Failed to start request: ' + error.message, true);
      restoreBtn();
    }
  }

  function renderSelection(state) {
    selectionArea.innerHTML = '';
    matchStatusLabel.textContent = `Tool Selected - Awaiting User Feedback`;
    
    // Find the specific tool details
    const selectedTool = state.batchTools.find(t => t.id === state.selectedToolId);
    
    if (selectedTool) {
      const card = document.createElement('div');
      card.className = 'match-card';
      card.innerHTML = `
        <div style="font-size: 0.8rem; color: #3b82f6; font-weight: bold; margin-bottom: 0.5rem; text-transform: uppercase;">LLM Pick</div>
        <div class="match-name">${escapeHTML(selectedTool.name)}</div>
        <div class="match-desc">${escapeHTML(selectedTool.description)}</div>
        <div style="font-size: 0.75rem; color: #64748b; margin-top: 0.5rem;">Batch context: LLM evaluated ${state.batchTools.length} candidates.</div>
      `;
      selectionArea.appendChild(card);
    }

    feedbackActions.style.display = 'flex';
  }

  btnAgree.addEventListener('click', () => sendFeedback(true));
  btnDisagree.addEventListener('click', () => sendFeedback(false));

  async function sendFeedback(isBestMatch) {
    if (!currentSelectionState) return;
    
    feedbackActions.style.display = 'none';
    appendLog(`[SYSTEM] User clicked ${isBestMatch ? 'Agree' : 'Disagree'}. Submitting feedback...`);

    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: currentSelectionState.intent,
          objective: currentSelectionState.objective,
          batchIds: currentSelectionState.batchIds,
          selectedToolId: currentSelectionState.selectedToolId,
          isBestMatch
        })
      });

      appendLog(`[SYSTEM] Feedback logged to Resolution Ledger and Rankings Updated.`);

      if (isBestMatch) {
         matchStatusLabel.textContent = `Execution Complete (Success)`;
         restoreBtn();
      } else {
         matchStatusLabel.textContent = `Seeking next candidate...`;
         // Resume Orchestrator matching cycle from next index
         startOrchestratorPhase({
            objective: currentSelectionState.objective,
            resumeIntent: currentSelectionState.intent,
            resumeMainIndex: currentSelectionState.nextMainIndex,
            resumeAuditionIndex: currentSelectionState.nextAuditionIndex
         });
      }
    } catch (err) {
      appendLog(`[ERROR] Failed to send feedback: ${err.message}`, true);
      restoreBtn();
    }
  }

  function restoreBtn() {
    btnText.style.display = 'block';
    loaderSpinner.style.display = 'none';
    submitBtn.disabled = false;
  }

  function appendLog(msg, isError = false) {
    const el = document.createElement('div');
    el.className = 'log-entry' + (isError ? ' error' : '');
    const time = new Date().toLocaleTimeString([], { hour12: false });
    
    el.innerHTML = `<span class="log-prefix">[${time}]</span> ${escapeHTML(msg)}`;
    logsWindow.appendChild(el);
    logsWindow.scrollTop = logsWindow.scrollHeight;
  }

  function escapeHTML(str) {
    const p = document.createElement('p');
    p.appendChild(document.createTextNode(str));
    return p.innerHTML;
  }
});
