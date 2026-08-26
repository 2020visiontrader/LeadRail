// Regenerates tests/fixtures. Run from the repo root: node tests/fixtures/make.mjs
// Kept in the tree so a fixture can be rebuilt or extended rather than being
// binary blobs nobody can explain.
import XLSX from 'xlsx';
import fs from 'fs';
const d='tests/fixtures';
// XLSX
const wb=XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name','email','score'],['Ada','ada@x.com',91]]), 'Leads');
XLSX.writeFile(wb, `${d}/leads.xlsx`);
// CSV / TXT / MD / JSON
fs.writeFileSync(`${d}/leads.csv`, 'name,email\nAda,ada@x.com\nGrace,grace@y.io\n');
fs.writeFileSync(`${d}/brief.txt`, 'Q3 goal: 200 qualified leads.');
fs.writeFileSync(`${d}/notes.md`, '# Brief\n\nShip the thing.');
fs.writeFileSync(`${d}/cfg.json`, JSON.stringify({goal:200}));
// A PDF with a real text layer, hand-built (no generator dep).
const content='BT /F1 24 Tf 72 700 Td (Q3 goal 200 qualified leads) Tj ET';
const objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
 `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
 '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
let pdf='%PDF-1.4\n'; const off=[];
objs.forEach((o,i)=>{off.push(pdf.length); pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});
const xref=pdf.length;
pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+off.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('');
pdf+=`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
fs.writeFileSync(`${d}/brief.pdf`, pdf, 'latin1');
// A "scanned" PDF: a STRUCTURALLY VALID pdf whose page draws no text — which
// is what an exported scan actually is. The previous fixture was random bytes,
// so pdf-parse rejected it as malformed and never reached the no-text-layer
// branch: the fixture was wrong, not the code.
const blank = '  '.repeat(1200); // page content with no text operators
const sobjs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>',
 `<< /Length ${blank.length} >>\nstream\n${blank}\nendstream`];
let spdf='%PDF-1.4\n'; const soff=[];
sobjs.forEach((o,i)=>{soff.push(spdf.length); spdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});
const sxref=spdf.length;
spdf+=`xref\n0 ${sobjs.length+1}\n0000000000 65535 f \n`+soff.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('');
spdf+=`trailer\n<< /Size ${sobjs.length+1} /Root 1 0 R >>\nstartxref\n${sxref}\n%%EOF`;
fs.writeFileSync(`${d}/scan.pdf`, spdf, 'latin1');
console.log('fixtures written');
