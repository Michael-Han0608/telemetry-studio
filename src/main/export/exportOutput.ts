import { realpath, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

/** Compare absolute paths using the target filesystem's spelling rules, not raw strings. */
export function exportPathKey(filePath: string, platform = process.platform): string {
  if (platform === 'win32') {
    // Also equate slash variants and the extended-length \\?\ prefix on Windows.
    return path.win32.toNamespacedPath(path.win32.resolve(filePath)).toLowerCase()
  }
  return path.resolve(filePath)
}

/** A completed export omits the camera's GPMF stream: replacing ANY source is data loss. */
export async function assertSafeExportOutput(outputPath: string, sourcePaths: readonly string[]): Promise<void> {
  const outputKey = exportPathKey(outputPath)
  const rejectSourceOverwrite = (): never => {
    throw new Error('Export output must not overwrite a source video. Choose a different file name or folder.')
  }
  if (sourcePaths.some((sourcePath) => exportPathKey(sourcePath) === outputKey)) rejectSourceOverwrite()

  const identity = async (filePath: string) => {
    try {
      const [canonicalPath, info] = await Promise.all([realpath(filePath), stat(filePath, { bigint: true })])
      return { canonicalKey: exportPathKey(canonicalPath), dev: info.dev, ino: info.ino }
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error // Permission and other filesystem errors fail closed, never authorize replacement.
    }
  }
  const output = await identity(outputPath)
  if (!output) return
  const sources = await Promise.all(sourcePaths.map(identity))
  if (sources.some((source) => source && (
    source.canonicalKey === output.canonicalKey ||
    (source.ino !== 0n && source.dev === output.dev && source.ino === output.ino)
  ))) rejectSourceOverwrite()
}

export async function removeAttemptFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if (!isMissingFile(error)) console.warn(`[export] could not clean temporary output ${filePath}:`, error)
  }
}

export function attemptOutputPath(outputPath: string, jobId: string, attemptId: number): string {
  // Keep the final .mp4 extension so ffmpeg selects the same muxer as the user-facing output.
  return `${outputPath}.telemetry-studio-${jobId}-${attemptId}.tmp.mp4`
}

/**
 * Publishes a completed attempt without exposing a partially encoded file as the final output.
 * The backup is kept in the same directory/volume, so the two renames do not cross filesystems.
 * If replacing an existing file fails, the old file is restored when possible.
 */
export async function commitAttemptOutput(
  tempPath: string,
  outputPath: string,
  jobId: string,
  sourcePaths: readonly string[]
): Promise<void> {
  // Check again after encoding: an existing destination may now alias a source file.
  await assertSafeExportOutput(outputPath, sourcePaths)
  const backupPath = `${outputPath}.telemetry-studio-${jobId}.backup`
  let backedUpExistingOutput = false

  try {
    try {
      await rename(outputPath, backupPath)
      backedUpExistingOutput = true
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }

    try {
      await rename(tempPath, outputPath)
    } catch (error) {
      if (backedUpExistingOutput) {
        try {
          await rename(backupPath, outputPath)
          backedUpExistingOutput = false
        } catch (restoreError) {
          // Leave the backup in place for manual recovery; the finally block must not delete it
          // after we report where the previous user output was preserved.
          backedUpExistingOutput = false
          throw new Error(
            `Export completed but could not publish ${outputPath}; the previous file is preserved at ${backupPath}. ` +
              `Publish error: ${String(error)}; restore error: ${String(restoreError)}`
          )
        }
      }
      throw error
    }
  } finally {
    if (backedUpExistingOutput) await removeAttemptFile(backupPath)
  }
}
