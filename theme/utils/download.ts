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

export const downloadFile = (url: string, filename: string) => {
  const isSameOrigin =
    url.startsWith("/") || url.startsWith(window.location.origin);

  if (isSameOrigin) {
    fetch(`/knowledge/${url}`)
      .then((res) =>
        res.ok ? res.blob() : Promise.reject(new Error("Failed to fetch"))
      )
      .then((blob) => {
        const blobUrl = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          window.URL.revokeObjectURL(blobUrl);
          document.body.removeChild(a);
        }, 100);
      })
      .catch(() => console.warn("Failed to download file:", url));
  } else {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
  }
};

