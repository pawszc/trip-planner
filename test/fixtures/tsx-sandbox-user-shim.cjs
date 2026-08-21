/* global process */

// The managed Windows test sandbox blocks os.userInfo(), which tsx calls only to name its temp
// directory. Real developer/CI environments do not need this child-process-only compatibility shim.
if (typeof process.geteuid !== 'function') {
  Object.defineProperty(process, 'geteuid', {
    configurable: true,
    value: () => 1_000,
  });
}
