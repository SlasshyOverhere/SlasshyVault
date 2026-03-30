const crypto = require('crypto');

function generateMockData(count) {
  const data = [];
  for (let i = 0; i < count; i++) {
    data.push({
      id: i,
      title: crypto.randomBytes(8).toString('hex') + (i % 5 === 0 ? " search" : "")
    });
  }
  return data;
}

const items = generateMockData(10000);
const query = "search";

// Method 1: Original
console.time('Original Sort');
const combinedOriginal = [...items];
combinedOriginal.sort((a, b) => {
  const aTitle = a.title.toLowerCase();
  const bTitle = b.title.toLowerCase();
  if (aTitle === query && bTitle !== query) return -1;
  if (bTitle === query && aTitle !== query) return 1;
  if (aTitle.startsWith(query) && !bTitle.startsWith(query)) return -1;
  if (bTitle.startsWith(query) && !aTitle.startsWith(query)) return 1;
  return aTitle.localeCompare(bTitle);
});
console.timeEnd('Original Sort');


// Method 2: Schwartzian Transform
console.time('Schwartzian Transform');
const combinedOptimized = [...items];
const mappedCombined = combinedOptimized.map(item => ({
  item,
  lowerTitle: item.title.toLowerCase()
}));

mappedCombined.sort((a, b) => {
  const aTitle = a.lowerTitle;
  const bTitle = b.lowerTitle;
  if (aTitle === query && bTitle !== query) return -1;
  if (bTitle === query && aTitle !== query) return 1;
  if (aTitle.startsWith(query) && !bTitle.startsWith(query)) return -1;
  if (bTitle.startsWith(query) && !aTitle.startsWith(query)) return 1;
  return aTitle.localeCompare(bTitle);
});
const resultOptimized = mappedCombined.map(entry => entry.item);
console.timeEnd('Schwartzian Transform');
