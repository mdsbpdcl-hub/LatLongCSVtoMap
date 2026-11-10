// Generates synthetic test CSV files (no real consumer data).
// Usage: node scripts/make-samples.mjs            -> small samples into public/samples
//        node scripts/make-samples.mjs big 1000000 -> large file into test-data/
import fs from 'node:fs';
import path from 'node:path';

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const DISTRICTS = [
  ['Patna', 25.594, 85.137, ['Patna Central', 'Patna East', 'Danapur', 'Barh']],
  ['Gaya', 24.795, 85.0, ['Gaya Urban', 'Sherghati', 'Tekari']],
  ['Nalanda', 25.136, 85.443, ['Bihar Sharif', 'Hilsa', 'Rajgir']],
  ['Bhojpur', 25.556, 84.663, ['Arrah', 'Jagdishpur', 'Piro']],
  ['Rohtas', 24.95, 84.03, ['Sasaram', 'Dehri', 'Bikramganj']],
  ['Bhagalpur', 25.244, 86.972, ['Bhagalpur Urban', 'Kahalgaon', 'Naugachia']],
  ['Munger', 25.375, 86.473, ['Munger', 'Jamalpur', 'Tarapur']],
  ['Aurangabad', 24.752, 84.374, ['Aurangabad', 'Daudnagar', 'Nabinagar']],
];
const CATEGORIES = ['Domestic', 'Non-Domestic', 'Industrial LT', 'Agriculture', 'Public Water Works'];
const STATUS = ['Connected', 'Connected', 'Connected', 'Connected', 'Disconnected', 'Pending', 'Temporary Disconnected'];
const FIRST = ['Ram', 'Sita', 'Mohan', 'Anita', 'Suresh', 'Kavita', 'Rajesh', 'Pooja', 'Amit', 'Sunita', 'Vikas', 'Rekha'];
const LAST = ['Kumar', 'Singh', 'Prasad', 'Devi', 'Yadav', 'Sharma', 'Mishra', 'Paswan', 'Gupta', 'Jha'];

function q(v) { v = String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

function consumerRow(i, opts = {}) {
  const [d, lat0, lon0, divs] = pick(DISTRICTS);
  const div = pick(divs);
  const sub = `${div} Sub-${1 + Math.floor(rnd() * 3)}`;
  const feeder = `${div.split(' ')[0].toUpperCase().slice(0, 4)}-F${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}`;
  let lat = (lat0 + (rnd() - 0.5) * 0.5).toFixed(6);
  let lon = (lon0 + (rnd() - 0.5) * 0.5).toFixed(6);
  const amt = Math.floor(Math.pow(rnd(), 3) * 25000);
  const y = 2015 + Math.floor(rnd() * 10), m = 1 + Math.floor(rnd() * 12), dd = 1 + Math.floor(rnd() * 28);
  const date = `${String(dd).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
  if (opts.bad) {
    const k = i % 10;
    if (k === 0) lat = '';
    else if (k === 1) lon = 'NA';
    else if (k === 2) [lat, lon] = [lon, lat]; // swapped
    else if (k === 3) { lat = '0'; lon = '0'; }
    else if (k === 4) lat = '125.5';
  }
  const name = `${pick(FIRST)} ${pick(LAST)}${rnd() < 0.05 ? ', "Bablu"' : ''}`;
  return [
    `1${String(100000000 + i)}`, name, d, div, sub, feeder, pick(CATEGORIES), pick(STATUS), date, amt, lat, lon,
  ].map(q).join(',');
}
const CONSUMER_HEADER = 'Consumer Number,Consumer Name,District,Division,Subdivision,Feeder,Category,Consumer Status,Connection Date,Outstanding Amount,Latitude,Longitude';

function dtrRow(i) {
  const [d, lat0, lon0, divs] = pick(DISTRICTS);
  const div = pick(divs);
  return [`DTR${String(i).padStart(6, '0')}`, `${div} DT ${i}`, pick([25, 63, 100, 200, 315]), d,
    `${div.split(' ')[0].toUpperCase().slice(0, 4)}-F${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}`,
    pick(['Working', 'Working', 'Working', 'Failed', 'Under repair']),
    (lon0 + (rnd() - 0.5) * 0.5).toFixed(6), (lat0 + (rnd() - 0.5) * 0.5).toFixed(6)].map(q).join(';');
}
const DTR_HEADER = 'DTR Code;DTR Name;Capacity (kVA);District;Feeder Code;Working Status;Long;Lat';

const mode = process.argv[2] || 'small';
if (mode === 'small') {
  const dir = 'public/samples';
  fs.mkdirSync(dir, { recursive: true });
  let s = CONSUMER_HEADER + '\r\n';
  for (let i = 0; i < 2000; i++) s += consumerRow(i) + '\r\n';
  fs.writeFileSync(path.join(dir, 'sample_consumers.csv'), s);
  let b = CONSUMER_HEADER + '\r\n';
  for (let i = 0; i < 60; i++) b += consumerRow(5000 + i, { bad: true }) + '\r\n';
  fs.writeFileSync(path.join(dir, 'sample_with_errors.csv'), b);
  let t = DTR_HEADER + '\r\n';
  for (let i = 0; i < 500; i++) t += dtrRow(i) + '\r\n';
  fs.writeFileSync(path.join(dir, 'sample_transformers_semicolon.csv'), t);
  console.log('Small samples written to', dir);
} else {
  const n = Number(process.argv[3] || 1000000);
  fs.mkdirSync('test-data', { recursive: true });
  const file = path.join('test-data', `consumers_${n}.csv`);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, CONSUMER_HEADER + '\r\n');
  let buf = [];
  for (let i = 0; i < n; i++) {
    buf.push(consumerRow(i, { bad: i % 997 === 0 }));
    if (buf.length === 50000) { fs.writeSync(fd, buf.join('\r\n') + '\r\n'); buf = []; }
  }
  if (buf.length) fs.writeSync(fd, buf.join('\r\n') + '\r\n');
  fs.closeSync(fd);
  console.log('Wrote', file, (fs.statSync(file).size / 1e6).toFixed(1), 'MB');
}
