// Stands in for a runtime that emulates Node without implementing this function (workerd).
const nodeModule = require('node:module');
const sync = nodeModule.syncBuiltinESMExports;
nodeModule.syncBuiltinESMExports = () => {
  throw new Error('The module.syncBuiltinESMExports method is not implemented');
};
sync();
