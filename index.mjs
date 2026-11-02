import server from './src/plugin.mjs';
import v2 from './src/plugin-v2.mjs';
// V1 >=1.18.29 calls server(); V2 calls setup().
export default { ...v2, server };
