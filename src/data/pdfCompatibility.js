/**
 * Responsibility: Adds Promise.withResolvers, which PDF.js calls, where the
 *   browser lacks it (before Safari 17.4, Chrome 119 and Firefox 121).
 * Layer: Data. Side-effect script; no imports or exports.
 * Dependencies: None.
 *
 * Must run before PDF.js in the page and in its worker: pdfRuntime.ts imports
 * it, and vite.config.ts prepends this source to the worker module, so it
 * stays plain JavaScript.
 */
if (typeof Promise.withResolvers !== "function") {
  Object.defineProperty(Promise, "withResolvers", {
    configurable: true,
    writable: true,
    // A plain function: `this` is the constructor it is called on, as with
    // the standard method.
    value: function () {
      let resolve, reject;
      const promise = new this((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
  });
}
