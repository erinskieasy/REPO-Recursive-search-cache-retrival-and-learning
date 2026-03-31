document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('prompt-form');
  const promptInput = document.getElementById('prompt-input');
  const submitBtn = document.getElementById('submit-btn');
  const btnText = submitBtn.querySelector('.btn-text');
  const loaderSpinner = submitBtn.querySelector('.loader-spinner');
  
  const resultsSection = document.getElementById('results-section');
  const logsWindow = document.getElementById('logs-window');
  const matchesGrid = document.getElementById('matches-grid');
  const matchCountLabel = document.getElementById('match-count');

  let activeStreamSource = null;

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
    matchesGrid.innerHTML = '';
    matchCountLabel.textContent = '0 found';

    // Disconnect old stream if exists
    if (activeStreamSource) {
      activeStreamSource.close();
    }

    try {
      // 1. Open Server-Sent Events stream
      activeStreamSource = new EventSource('/api/stream');
      
      activeStreamSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'connected') {
          // 2. Once connected, fire the fetch request with the streamId
          const streamId = data.id;
          fetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, streamId })
          }).catch(err => {
            appendLog('Error querying server: ' + err.message, true);
            restoreBtn();
          });
        }
        else if (data.type === 'log') {
          appendLog(data.payload);
        }
        else if (data.type === 'match') {
          const tools = data.payload;
          tools.forEach(tool => appendMatch(tool));
        }
        else if (data.type === 'done') {
          appendLog(`[SYSTEM] Finished. Capability Matches: ${data.payload.totalMatches}`);
          matchCountLabel.textContent = `${data.payload.totalMatches} found`;
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
  });

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
    
    // Auto scroll
    logsWindow.scrollTop = logsWindow.scrollHeight;
  }

  function appendMatch(tool) {
    const card = document.createElement('div');
    card.className = 'match-card';
    card.innerHTML = `
      <div class="match-name">${escapeHTML(tool.name)}</div>
      <div class="match-desc">${escapeHTML(tool.description)}</div>
    `;
    matchesGrid.appendChild(card);
    
    // Update count quickly
    const current = matchesGrid.children.length;
    matchCountLabel.textContent = `${current} found`;
  }

  function escapeHTML(str) {
    const p = document.createElement('p');
    p.appendChild(document.createTextNode(str));
    return p.innerHTML;
  }
});
