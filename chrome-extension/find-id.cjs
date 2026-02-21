const crypto = require('crypto');

function pathToExtId(p) {
  const hash = crypto.createHash('sha256').update(p, 'utf8').digest('hex');
  return hash.slice(0, 32).split('').map(c =>
    String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))
  ).join('');
}

const paths = [
  'D:\\Applications\\unstract\\chrome-extension\\dist',
  'd:\\applications\\unstract\\chrome-extension\\dist',
  'D:/Applications/unstract/chrome-extension/dist',
  'd:/applications/unstract/chrome-extension/dist',
  'D:\\Applications\\unstract\\chrome-extension\\dist\\',
];

paths.forEach(p => console.log(pathToExtId(p), '<-', p));
