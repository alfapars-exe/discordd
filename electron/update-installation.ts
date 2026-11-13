/** Share one install attempt across notification, tray and renderer entry points. */
type InstallationErrors = {
  on: (event: "error", listener: () => void) => unknown;
  removeListener: (event: "error", listener: () => void) => unknown;
};

export function createUpdateInstallationGate(): (install: () => void, errors?: InstallationErrors) => void {
  let installing = false;
  return (install, errors) => {
    if (installing) return;
    installing = true;
    let reportedFailure = false;
    const failed = () => { reportedFailure = true; };
    // electron-updater may report a failed synchronous install through its
    // error event instead of throwing. Observe only this call's execution.
    errors?.on("error", failed);
    try {
      install();
      if (reportedFailure) installing = false;
    } catch (error) {
      installing = false;
      throw error;
    } finally {
      errors?.removeListener("error", failed);
    }
  };
}

export const requestUpdateInstallation = createUpdateInstallationGate();
