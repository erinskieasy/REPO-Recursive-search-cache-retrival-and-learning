document.addEventListener('DOMContentLoaded', () => {
  const toolListGrid = document.getElementById('tool-list-grid');
  const toolCount = document.getElementById('tool-count');
  const addToolForm = document.getElementById('add-tool-form');
  const dynamicProps = document.getElementById('dynamic-props');
  const addPropBtn = document.getElementById('add-prop-btn');

  function createPropRow(key = '', val = '') {
    const row = document.createElement('div');
    row.className = 'prop-row';
    row.innerHTML = `
      <input type="text" class="prop-key" placeholder="Key (e.g. requiresApi)" value="${key}" required />
      <input type="text" class="prop-val" placeholder="Value (e.g. true)" value="${val}" required />
      <button class="btn-secondary remove-prop-btn" type="button">X</button>
    `;
    
    row.querySelector('.remove-prop-btn').addEventListener('click', () => {
      row.remove();
    });
    
    dynamicProps.appendChild(row);
  }

  addPropBtn.addEventListener('click', () => createPropRow());

  async function loadTools() {
    try {
      const res = await fetch('/api/tools');
      const data = await res.json();
      const tools = data.tools || [];
      
      toolCount.textContent = tools.length;
      toolListGrid.innerHTML = '';
      
      tools.forEach(tool => {
        const card = document.createElement('div');
        card.className = 'tool-card';
        card.innerHTML = `
          <h4>${escapeHTML(tool.name)}</h4>
          <p>${escapeHTML(tool.description)}</p>
          <div class="tool-props">
            <strong>Properties:</strong><br/>
            ${Object.keys(tool.properties).map(k => `${escapeHTML(k)}: ${escapeHTML(JSON.stringify(tool.properties[k]))}`).join('<br/>') || 'None'}
          </div>
        `;
        toolListGrid.appendChild(card);
      });
    } catch (err) {
      console.error(err);
    }
  }

  addToolForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const name = document.getElementById('tool-name').value.trim();
    const description = document.getElementById('tool-desc').value.trim();
    
    const properties = {};
    const rows = dynamicProps.querySelectorAll('.prop-row');
    rows.forEach(row => {
      const key = row.querySelector('.prop-key').value.trim();
      let val = row.querySelector('.prop-val').value.trim();
      
      // Attempt to parse booleans or numbers to keep correct JSON types
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (!isNaN(val) && val !== '') val = Number(val);
      
      if (key) {
        properties[key] = val;
      }
    });

    try {
      const res = await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, properties })
      });
      
      if (res.ok) {
        addToolForm.reset();
        dynamicProps.innerHTML = '';
        createPropRow(); // Default empty row for next time
        loadTools();
      } else {
        const error = await res.json();
        alert('Error adding tool: ' + error.error);
      }
    } catch (err) {
      console.error(err);
      alert('Error adding tool');
    }
  });

  function escapeHTML(str) {
    if (typeof str !== 'string') str = String(str);
    const p = document.createElement('p');
    p.appendChild(document.createTextNode(str));
    return p.innerHTML;
  }

  // Init
  loadTools();
  createPropRow(); // Init with one empty prop row
});
