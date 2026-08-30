const line = '1A,空いている,0,"今すぐ入れます, 注意事項あり"';
const parts = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);
console.log(parts);

// Better standard approach
function parseCSVLine(text) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for(let i=0; i<text.length; i++) {
    const char = text[i];
    if (char === '"' && text[i+1] === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
console.log(parseCSVLine(line));
