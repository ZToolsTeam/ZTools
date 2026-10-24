import fs from 'fs';
const data = fs.readFileSync('secret.txt', 'utf8');
console.log(data);
