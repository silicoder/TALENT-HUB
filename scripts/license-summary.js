'use strict';

const pkg = require('../package.json');
const names = Object.keys(pkg.dependencies || {}).sort();
console.log(`Project license: ${pkg.license || 'not declared'}`);
console.log(`Direct runtime npm dependencies: ${names.length}`);
if (names.length === 0) {
  console.log('No third-party runtime npm package licenses to enumerate.');
  console.log('Review Node.js runtime, SQLite, system libraries and any separately copied/reused code independently.');
} else {
  console.log(names.join('\n'));
}
