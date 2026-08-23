export type DownloadFileProgress = { loaded: number; total: number }

export function aggregateModelDownloadProgress(
  files: Iterable<DownloadFileProgress>,
  estimatedTotalBytes: number,
) {
  const discovered = [...files].reduce((sum, file) => ({
    loadedBytes: sum.loadedBytes + file.loaded,
    totalBytes: sum.totalBytes + file.total,
  }), { loadedBytes: 0, totalBytes: 0 })
  const totalBytes = Math.max(estimatedTotalBytes, discovered.totalBytes)
  return {
    loadedBytes: discovered.loadedBytes,
    totalBytes,
    progress: totalBytes > 0 ? Math.min(99, discovered.loadedBytes / totalBytes * 100) : 0,
  }
}
