const DOWNLOAD_EXTENSIONS = [
  ".ipynb",
  ".zip",
  ".tgz",
  ".tar.gz",
  ".sh",
  ".py",
  ".sql",
];

export const shouldDownload = (pathname: string): boolean => {
  const lowerPath = pathname.toLowerCase();
  return DOWNLOAD_EXTENSIONS.some((ext) => lowerPath.endsWith(ext));
};

export const getPathname = (href: string): string => {
  try {
    return new URL(href, window.location.origin).pathname;
  } catch {
    return href.split("?")[0].split("#")[0];
  }
};
