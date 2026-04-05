const ids = Array.from({length: 1000}, (_, i) => String(i));
const set = new Set(ids);
const target = '999';

console.time('includes');
for(let i=0; i<10000; i++) ids.includes(target);
console.timeEnd('includes');

console.time('set.has');
for(let i=0; i<10000; i++) set.has(target);
console.timeEnd('set.has');
