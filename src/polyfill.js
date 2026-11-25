// pdf.js 4 cần Promise.withResolvers — Safari/Chrome cũ chưa có
if (!Promise.withResolvers) {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
  };
}
