// app.js - readable, full logic
// Features:
// - Parse Step1 Excel (Name, Meter No., Consumption)
// - OCR images (Tesseract) in upload order
// - On-screen: only OCR rows (if matched, show Step1 columns in that row)
// - Editable OCR fields (MeterNo, CurrentConsumption) -> auto rematch & recalc
// - % Difference = absolute value; highlight red (>30%), green (<=30%), gray if N/A
// - Export: include OCR rows (in upload order) + append unmatched Step1 rows (CurrentConsumption blank)
// - Draggable green floating success notification after export
// - Debug toggle (hidden by default) shows raw OCR text + source info

// --- Elements
const prevExcel = document.getElementById('prevExcel');
const prevStatus = document.getElementById('prevStatus');
const fileInput = document.getElementById('fileInput');
const cameraInput = document.getElementById('cameraInput');
const clearBtn = document.getElementById('clearBtn');
const exportBtn = document.getElementById('exportBtn');
const statusSpan = document.getElementById('status');
const resultsBody = document.getElementById('resultsBody');
const debugToggle = document.getElementById('toggleDebug');
const debugDiv = document.getElementById('debug');
const debugLog = document.getElementById('debugLog');

// --- State
let prevData = [];     // array of {Name, Meter, CleanMeter, Consumption}
let ocrResults = [];   // array preserving upload order: {id, preview, rawText, meterOCR, consumptionOCR, matchedPrevKey?}
let nextId = 1;

// --- Helpers
function cleanMeter(s){
  if(!s) return '';
  return String(s).replace(/[^A-Z0-9\-]/ig,'').toUpperCase().trim();
}

function calcDiffAbs(prev, curr){
  const pn = parseFloat(String(prev).replace(/,/g,'')); // prev from step1
  const cn = parseFloat(String(curr).replace(/,/g,'')); // current from OCR/edit
  if(!isFinite(pn) || pn === 0 || !isFinite(cn)) return { text: '—', cls: 'diff-gray' };
  const diff = Math.abs(((cn - pn) / pn) * 100);
  const rounded = (Math.round(diff * 10) / 10).toFixed(1) + '%';
  return diff > 30 ? { text: rounded, cls: 'diff-red' } : { text: rounded, cls: 'diff-green' };
}

// find prev record by cleaned meter or last6 digits
function findPrevByOCR(meterOCR){
  const cleaned = cleanMeter(meterOCR);
  if(!cleaned) return null;
  // exact cleaned match
  const exact = prevData.find(r => r.CleanMeter === cleaned);
  if(exact) return exact;
  // last6 fallback
  const digits = cleaned.replace(/[^0-9]/g,'');
  const last6 = digits.slice(-6);
  if(last6){
    return prevData.find(r => (r.CleanMeter.replace(/[^0-9]/g,'').slice(-6) === last6));
  }
  return null;
}

// --- Step 1: parse Excel
prevExcel.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(!file) return;
  prevStatus.textContent = 'Loading Excel...';
  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const data = new Uint8Array(evt.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      prevData = json.map(row => {
        // try various key names permissively
        const name = row.Name || row.name || row['Account Name'] || row['Customer'] || '';
        const meter = row['Meter No.'] || row['Meter No'] || row['MeterNo'] || row['Meter'] || row.Meter || '';
        const cons = row.Consumption || row['Consumption Qty'] || row.Qty || row['Prev Consumption'] || row['Prev'] || '';
        return { Name: String(name).trim(), Meter: String(meter).trim(), CleanMeter: cleanMeter(meter), Consumption: String(cons).trim() };
      });
      prevStatus.textContent = `Loaded ${prevData.length} records.`;
    } catch (err) {
      prevStatus.textContent = 'Error reading Excel: ' + err.message;
      console.error(err);
    }
  };
  reader.readAsArrayBuffer(file);
});

// --- OCR processing
async function recognizeDataURL(dataURL, name){
  // use worker for performance on non-iOS; Tesseract exposes both recognize and createWorker
  try {
    const { createWorker } = Tesseract;
    const worker = await createWorker({
      logger: m => {
        if(m.status === 'recognizing text') statusSpan.textContent = `${name}: ${Math.round(m.progress*100)}%`;
      }
    });
    await worker.loadLanguage('eng');
    await worker.initialize('eng');
    const res = await worker.recognize(dataURL);
    await worker.terminate();
    return res && res.data ? res.data : null;
  } catch (err) {
    console.error('Tesseract error', err);
    return null;
  }
}

function extractMeterFromTextBlocks(data){
  // prefer analyzing words/lines if available; fall back to plain text.
  const text = (data && data.text) ? data.text : '';
  // look for line below label Meter No.
  // common patterns: "Meter No", "METER NO", "Meter No."
  let m = text.match(/Meter\s*No\.?\s*\:?\s*[\r\n\s]*([A-Z0-9\-\s]{5,40})/i);
  if(m && m[1]) return cleanMeter(m[1]);
  // fallback search for tokens starting with AJP or pattern like AJP-15-24-392020
  m = text.match(/(AJP[^\s,]*)/i);
  if(m) return cleanMeter(m[1]);
  // another generic pattern with hyphens and digits
  m = text.match(/([A-Z0-9]{2,3}-\d{1,2}-\d{1,2}-\d{3,})/i);
  if(m) return cleanMeter(m[1]);
  // fallback any long alphanumeric token
  m = text.match(/\b([A-Z0-9\-]{6,})\b/i);
  if(m) return cleanMeter(m[1]);
  return '';
}

function extractConsumptionFromTextBlocks(data){
  const text = (data && data.text) ? data.text : '';
  // look for Qty label then number below/after
  let m = text.match(/Qty\s*\:?\s*[\r\n\s]*([0-9]{1,5})/i);
  if(m && m[1]) return m[1];
  m = text.match(/Quantity\s*\:?\s*[\r\n\s]*([0-9]{1,5})/i);
  if(m && m[1]) return m[1];
  // fallback look for isolated small numbers (1-4 digits)
  m = text.match(/\b([0-9]{1,4})\b/);
  if(m) return m[1];
  return '';
}

// convert file object to data URL (preview and OCR)
function fileToDataURL(file){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// when images are uploaded/taken
fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if(files.length === 0) return;
  for(const f of files){
    await processImageFile(f);
  }
  statusSpan.textContent = 'Done';
});

cameraInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if(files.length === 0) return;
  for(const f of files){
    await processImageFile(f);
  }
  statusSpan.textContent = 'Done';
});

async function processImageFile(file){
  try{
    statusSpan.textContent = 'Preparing ' + file.name;
    const dataURL = await fileToDataURL(file);
    statusSpan.textContent = 'Running OCR on ' + file.name;
    const data = await recognizeDataURL(dataURL, file.name);
    const raw = data && data.text ? data.text : '';
    const meter = extractMeterFromTextBlocks(data) || 'Not Found';
    const qty = extractConsumptionFromTextBlocks(data) || 'Not Found';

    // push preserving upload order
    const entry = {
      id: nextId++,
      preview: dataURL,
      rawText: raw,
      meterOCR: meter,
      consumptionOCR: qty
    };
    ocrResults.push(entry);

    // append debug info
    appendDebug(`--- ${new Date().toLocaleString()} ---\nFILE: ${file.name}\nDETECTED METER: ${meter}\nDETECTED QTY: ${qty}\nOCR TEXT SNIPPET:\n${raw.slice(0,800)}\n`);

    renderResults(); // on-screen uses ocrResults in upload order
  }catch(err){
    console.error('processImageFile error', err);
    appendDebug('OCR error: ' + err.message);
  }
}

// Clear results
clearBtn.addEventListener('click', () => {
  ocrResults = [];
  nextId = 1;
  renderResults();
  statusSpan.textContent = 'Cleared';
  debugLog.textContent = '';
});

// Render table (ONLY OCR rows shown; if matched with Step1, Step1 info is shown in that row)
function renderResults(){
  resultsBody.innerHTML = '';
  ocrResults.forEach((r, idx) => {
    const prevMatch = findPrevByOCR(r.meterOCR);
    const name = prevMatch ? prevMatch.Name : 'Not Found';
    const meterPrev = prevMatch ? prevMatch.Meter : 'Not Found';
    const prevCons = prevMatch ? prevMatch.Consumption : 'Not Found';

    const diffObj = (prevMatch && r.consumptionOCR && prevCons !== 'Not Found') ? calcDiffAbs(prevCons, r.consumptionOCR) : { text: '—', cls: 'diff-gray' };

    // build row
    const tr = document.createElement('tr');
    tr.dataset.id = r.id;

    const previewTd = document.createElement('td');
    previewTd.innerHTML = r.preview ? `<img class="thumb" src="${r.preview}" />` : '';
    const nameTd = document.createElement('td'); nameTd.textContent = name;
    const meterPrevTd = document.createElement('td'); meterPrevTd.textContent = meterPrev;
    const prevConsTd = document.createElement('td'); prevConsTd.textContent = prevCons;

    const meterOCRtd = document.createElement('td');
    const meterInput = document.createElement('input');
    meterInput.className = 'editable';
    meterInput.value = r.meterOCR;
    meterInput.dataset.row = idx;
    meterInput.dataset.field = 'meterOCR';
    meterOCRtd.appendChild(meterInput);

    const consTd = document.createElement('td');
    const consInput = document.createElement('input');
    consInput.className = 'editable';
    consInput.value = r.consumptionOCR;
    consInput.dataset.row = idx;
    consInput.dataset.field = 'consumptionOCR';
    consTd.appendChild(consInput);

    const diffTd = document.createElement('td');
    diffTd.className = diffObj.cls;
    diffTd.textContent = diffObj.text;

    tr.appendChild(previewTd);
    tr.appendChild(nameTd);
    tr.appendChild(meterPrevTd);
    tr.appendChild(prevConsTd);
    tr.appendChild(meterOCRtd);
    tr.appendChild(consTd);
    tr.appendChild(diffTd);

    resultsBody.appendChild(tr);
  });

  attachEditHandlers(); // wire up edits
}

// wire editing events for inline correction
function attachEditHandlers(){
  document.querySelectorAll('input.editable').forEach(inp => {
    inp.oninput = (e) => {
      const row = parseInt(e.target.dataset.row, 10);
      const field = e.target.dataset.field;
      if(isNaN(row)) return;
      ocrResults[row][field] = e.target.value.trim();
      e.target.classList.add('edited');

      // if meterOCR changed, attempt rematch
      if(field === 'meterOCR'){
        const prevMatch = findPrevByOCR(ocrResults[row].meterOCR);
        // update UI immediately by rendering again
        renderResults();
        appendDebug(`Manual edit meterOCR: row ${ocrResults[row].id} -> ${ocrResults[row].meterOCR} matched ${prevMatch ? prevMatch.Meter : 'No match'}`);
      }

      // if consumption changed, recalc diff for that row
      if(field === 'consumptionOCR'){
        renderResults();
      }
    };
  });
}

// --- Export logic
exportBtn.addEventListener('click', () => {
  // Build rows in this order:
  // 1) OCR rows in upload order (visible rows) -> populate Name, MeterNo(prev) if matched, CurrentConsumption from edited value (or OCR)
  // 2) Append unmatched Step1 rows (not matched by any OCR row) with blank CurrentConsumption

  const exportRows = [];
  const matchedPrevKeys = new Set();

  // 1) OCR rows
  ocrResults.forEach(r => {
    const prev = findPrevByOCR(r.meterOCR);
    const name = prev ? prev.Name : 'Not Found';
    const meterPrev = prev ? prev.Meter : 'Not Found';
    const prevCons = prev ? prev.Consumption : 'Not Found';
    const currCons = r.consumptionOCR || '';

    // record matched prev (by cleaned key) so we later know which Step1 rows are unmatched
    if(prev && prev.CleanMeter) matchedPrevKeys.add(prev.CleanMeter);

    exportRows.push({
      Name: name,
      'Meter No.': meterPrev,
      'Prev Consumption': prevCons,
      'Current Consumption': currCons
    });
  });

  // 2) Append unmatched Step1 rows (Current Consumption blank)
  prevData.forEach(p => {
    if(!p.CleanMeter) return;
    if(!matchedPrevKeys.has(p.CleanMeter)){
      exportRows.push({
        Name: p.Name || '',
        'Meter No.': p.Meter || '',
        'Prev Consumption': p.Consumption || '',
        'Current Consumption': '' // blank per request
      });
    }
  });

  // Create sheet and export
  const ws = XLSX.utils.json_to_sheet(exportRows, { header: ['Name', 'Meter No.', 'Prev Consumption', 'Current Consumption'] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Results');
  XLSX.writeFile(wb, 'WaterBillOCR_v3_results.xlsx');

  showSuccessNotification('Export completed successfully. File downloaded.');
});

// --- Debug toggle
debugToggle.addEventListener('click', () => {
  if(debugDiv.style.display === 'block'){
    debugDiv.style.display = 'none';
    debugToggle.textContent = 'Show Debug';
  } else {
    debugDiv.style.display = 'block';
    debugToggle.textContent = 'Hide Debug';
  }
});

// helper to append debug text
function appendDebug(text){
  if(!debugLog) return;
  debugLog.textContent = (debugLog.textContent || '') + text + '\n\n';
}

// --- Floating draggable notification (green)
function showSuccessNotification(message){
  // if existing, remove
  let note = document.getElementById('wb_notify');
  if(note) note.remove();

  note = document.createElement('div');
  note.id = 'wb_notify';
  note.className = 'notify';
  note.innerHTML = `<span style="font-weight:700; margin-right:6px;">✅</span><div style="flex:1">${message}</div><button class="close" aria-label="close">✖</button>`;
  document.body.appendChild(note);

  // default position bottom-right (already styled in CSS), but set explicit coords for dragging logic
  note.style.right = '24px';
  note.style.bottom = '24px';
  note.style.left = 'unset';
  note.style.top = 'unset';

  // close button
  note.querySelector('.close').addEventListener('click', () => note.remove());

  // draggable (free-floating)
  let isDragging = false;
  let startX = 0, startY = 0, origX = 0, origY = 0;

  // convert current computed right/bottom to left/top coordinates
  function setInitialPosition(){
    const rect = note.getBoundingClientRect();
    note.style.left = (window.innerWidth - rect.right) + rect.left + 'px'; // keep current visual pos
    // set top based on bottom
    note.style.top = (rect.top) + 'px';
    note.style.right = 'unset';
    note.style.bottom = 'unset';
  }
  setInitialPosition();

  note.addEventListener('mousedown', (ev) => {
    // don't start dragging when clicking close
    if(ev.target.classList.contains('close')) return;
    isDragging = true;
    startX = ev.clientX;
    startY = ev.clientY;
    const rect = note.getBoundingClientRect();
    origX = rect.left;
    origY = rect.top;
    note.style.transition = 'none';
    ev.preventDefault();
  });

  window.addEventListener('mousemove', (ev) => {
    if(!isDragging) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    note.style.left = (origX + dx) + 'px';
    note.style.top = (origY + dy) + 'px';
  });

  window.addEventListener('mouseup', () => {
    if(isDragging) isDragging = false;
  });
}

// initial render (empty)
renderResults();
