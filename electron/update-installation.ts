/** Share one install attempt across notification, tray and renderer entry points. */
export function createUpdateInstallationGate(): (install: () => void) => void {
  let installing = false;
  return install => {
    if (installing) return;
    installing = true;
    try {
      install();
    } catch (error) {
      installing = false;
      throw error;
    }
  };
}

export const requestUpdateInstallation = createUpdateInstallationGate();
