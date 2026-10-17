import tmp from 'tmp';

// this registers a cleanup handler that will remove any tmp files on process exit
// see https://github.com/raszi/node-tmp#graceful-cleanup
tmp.setGracefulCleanup();

export function tmpPromise() {
  return new Promise<[string, number, () => void]>((resolve, reject) => {
    tmp.file((err, _path, fd, cleanup) => {
      if (err) {
        reject(err);
      } else {
        resolve([_path, fd, cleanup]);
      }
    });
  });
}
