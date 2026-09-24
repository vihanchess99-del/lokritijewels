import bcrypt from 'bcryptjs';
const password=process.argv.slice(2).join(' ');
if(!password){console.error('Usage: node generate-admin-hash.mjs "your-admin-password"');process.exit(1)}
console.log(bcrypt.hashSync(password,12));
