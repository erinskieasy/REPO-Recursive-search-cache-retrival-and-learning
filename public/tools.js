document.addEventListener('DOMContentLoaded', () => {
  const toolListGrid = document.getElementById('tool-list-grid');
  const toolCount = document.getElementById('tool-count');
  
  const addToolForm = document.getElementById('add-tool-form');
  const formTitle = document.getElementById('form-title');
  const toolIdInput = document.getElementById('tool-id');
  const submitBtn = document.getElementById('submit-btn');
  const cancelEditBtn = document.getElementById('cancel-edit-btn');
  
  const dynamicProps = document.getElementById('dynamic-props');
  const addPropBtn = document.getElementById('add-prop-btn');

  let allTools = [];

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
      allTools = data.tools || [];
      
      toolCount.textContent = allTools.length;
      toolListGrid.innerHTML = '';
      
      allTools.forEach(tool => {
        const card = document.createElement('div');
        card.className = 'tool-card';
        card.innerHTML = `
          <h4>${escapeHTML(tool.name)}</h4>
          <p>${escapeHTML(tool.description)}</p>
          <div class="tool-props">
            <strong>Properties:</strong><br/>
            ${Object.keys(tool.properties).map(k => `${escapeHTML(k)}: ${escapeHTML(JSON.stringify(tool.properties[k]))}`).join('<br/>') || 'None'}
          </div>
          <div class="tool-actions">
            <button class="btn-edit" data-id="${tool.id}">Edit</button>
            <button class="btn-danger" data-id="${tool.id}">Delete</button>
          </div>
        `;
        toolListGrid.appendChild(card);
      });
    } catch (err) {
      console.error(err);
    }
  }

  // Handle Edit/Delete clicks via delegation
  toolListGrid.addEventListener('click', async (e) => {
    if (e.target.classList.contains('btn-edit')) {
      const id = e.target.getAttribute('data-id');
      editTool(id);
    } else if (e.target.classList.contains('btn-danger')) {
      const id = e.target.getAttribute('data-id');
      await deleteTool(id);
    }
  });

  async function deleteTool(id) {
    if (!confirm('Are you sure you want to delete this tool?')) return;
    try {
      const res = await fetch(`/api/tools/${id}`, { method: 'DELETE' });
      if (res.ok) {
        loadTools();
        if (toolIdInput.value === id) resetForm(); // Cancel edit if deleting currently edited tool
      } else {
        const err = await res.json();
        alert('Error: ' + err.error);
      }
    } catch (err) {
      console.error(err);
      alert('Error deleting tool');
    }
  }

  function editTool(id) {
    const tool = allTools.find(t => t.id == id);
    if (!tool) return;
    
    formTitle.textContent = "Edit Tool";
    submitBtn.textContent = "Update Tool";
    cancelEditBtn.style.display = "inline-block";
    
    toolIdInput.value = tool.id;
    document.getElementById('tool-name').value = tool.name;
    document.getElementById('tool-desc').value = tool.description;
    
    dynamicProps.innerHTML = '';
    const keys = Object.keys(tool.properties);
    if (keys.length > 0) {
      keys.forEach(k => {
        const val = typeof tool.properties[k] === 'string' ? tool.properties[k] : JSON.stringify(tool.properties[k]);
        createPropRow(k, val);
      });
    } else {
      createPropRow();
    }
    
    // Scroll to top to see it
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetForm() {
    formTitle.textContent = "Add New Tool";
    submitBtn.textContent = "Save Tool";
    cancelEditBtn.style.display = "none";
    toolIdInput.value = '';
    addToolForm.reset();
    dynamicProps.innerHTML = '';
    createPropRow();
  }

  cancelEditBtn.addEventListener('click', () => {
    resetForm();
  });

  addToolForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const id = toolIdInput.value;
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
      const url = id ? `/api/tools/${id}` : '/api/tools';
      const method = id ? 'PUT' : 'POST';
      
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, properties })
      });
      
      if (res.ok) {
        resetForm();
        loadTools();
      } else {
        const error = await res.json();
        alert('Error saving tool: ' + error.error);
      }
    } catch (err) {
      console.error(err);
      alert('Error saving tool');
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
