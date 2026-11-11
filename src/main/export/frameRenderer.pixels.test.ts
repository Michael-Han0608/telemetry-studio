import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it, vi } from 'vitest'
import type { TelemetryData } from '../../shared/types'
import { createTelemetrySampler } from '../../shared/telemetry/sampleAt'
import type { Canvas2DLike } from '../../shared/render/canvas2d'
import { drawWidget } from '../../shared/render/drawWidget'
import { createWidget } from '../../shared/widgets/defaults'
import { createFrameRenderer } from './frameRenderer'

vi.mock('./registerFonts', () => ({ registerExportFonts: vi.fn() }))

const width = 640
const height = 360
const telemetry: TelemetryData = {
  deviceName: 'pixel-regression', gpsStream: 'GPS5', videoDurationMs: 20000,
  accel: [], gyro: [], gravity: [],
  samples: Array.from({ length: 201 }, (_, i) => ({
    cts: i * 100, lat: 30, lon: 106 + (i * 5) / (111195 * Math.cos(Math.PI / 6)),
    altitude: 300, speed2D: 50, speed3D: 50
  }))
}

describe('GPS window export pixels', () => {
  it.each(['solid', 'speed', 'braking'] as const)('matches the full drawing and ignores empty widgets in %s mode', async (colorMode) => {
    const sampler = createTelemetrySampler(telemetry)
    const gps = createWidget('gpsTrack')
    if (gps.type !== 'gpsTrack') throw new Error('expected GPS track')
    Object.assign(gps, { x: 0.4, y: 0.3, w: 0.2, h: 0.4 })
    Object.assign(gps.style, { viewMode: 'window', windowRadiusM: 25, dotGlow: false, colorMode })
    const emptyWidgets = [0, 0.95].map((position) => {
      const widget = createWidget('customText')
      if (widget.type !== 'customText') throw new Error('expected text')
      Object.assign(widget, { x: position, y: position, w: 0.05, h: 0.05 })
      Object.assign(widget.style, { text: '', backgroundOpacity: 0 })
      return widget
    })

    const renderer = await createFrameRenderer(width, height, [gps], sampler, null, 15, {}, {}, 20000, 0, 'Arial')
    const expanded = await createFrameRenderer(width, height, [gps, ...emptyWidgets], sampler, null, 15, {}, {}, 20000, 0, 'Arial')
    expect(renderer.roi).toEqual({ x: 0, y: 0, width, height })
    const reference = createCanvas(width, height)
    const ctx = reference.getContext('2d')

    for (const cts of [0, 10000, 20000]) {
      ctx.clearRect(0, 0, width, height)
      drawWidget(ctx as unknown as Canvas2DLike, gps, { x: gps.x * width, y: gps.y * height, w: gps.w * width, h: gps.h * height }, {
        trackPoints: sampler.trackPoints, bounds: sampler.bounds, dotPosition: sampler.positionAt(cts),
        hasGpsPosition: sampler.hasPositionAt(cts), speedMps: sampler.speedAt(cts), elapsedMs: cts, cts,
        trackSpeeds: sampler.trackSpeeds, trackCts: sampler.trackCts, speedBounds: sampler.speedBounds,
        trimStartMs: 0, sessionEndMs: 20000, projectFontFamily: 'Arial'
      })
      const pixels = renderer.renderFrame(cts, cts)
      expect(pixels.equals(Buffer.from(reference.data()))).toBe(true)
      expect(expanded.renderFrame(cts, cts).equals(pixels)).toBe(true)
    }
  })
})

describe('static export layer pixels', () => {
  it.each([
    ['speedometerAnalog', false], ['speedometerDigital', false], ['gForceDiagram', false], ['gForceDiagram', true]
  ] as const)('preserves fractional geometry and rotation for %s with IMU=%s', async (type, withImu) => {
    const sampler = createTelemetrySampler({
      ...telemetry,
      accel: withImu ? telemetry.samples.map(({ cts }) => ({ cts, x: 9.81, y: 0.3, z: 0.4 })) : []
    })
    for (const rotation of [0, 17]) {
      const widget = createWidget(type)
      Object.assign(widget, { x: 0.301, y: 0.203, w: 0.307, h: 0.409, rotation })
      const renderer = await createFrameRenderer(width, height, [widget], sampler, null, 15, {}, {}, 20000, 0, 'Arial')
      const reference = createCanvas(renderer.roi.width, renderer.roi.height)
      const ctx = reference.getContext('2d')
      ctx.translate(-renderer.roi.x, -renderer.roi.y)
      drawWidget(ctx as unknown as Canvas2DLike, widget,
        { x: widget.x * width, y: widget.y * height, w: widget.w * width, h: widget.h * height }, {
          trackPoints: sampler.trackPoints, bounds: sampler.bounds, dotPosition: sampler.positionAt(10000),
          hasGpsPosition: sampler.hasPositionAt(10000), speedMps: sampler.speedAt(10000), elapsedMs: 10000, cts: 10000,
          hasImuData: sampler.hasImuData,
          gForceReading: widget.type === 'gForceDiagram' ? sampler.gForceAt(10000, widget.style.smoothingMs) : undefined,
          gForceHistory: widget.type === 'gForceDiagram' ? sampler.gForceHistoryAt(10000, widget.style.trailDurationMs) : [],
          projectFontFamily: 'Arial'
        })
      const actual = renderer.renderFrame(10000, 10000)
      const expected = Buffer.from(reference.data())
      let maximumDifference = 0
      for (let i = 0; i < actual.length; i++) maximumDifference = Math.max(maximumDifference, Math.abs(actual[i] - expected[i]))
      expect(maximumDifference, `rotation=${rotation}`).toBeLessThanOrEqual(2)
    }
  })
})

// The reference has a real widget-sized backing store, as in WidgetCanvas. An empty
// neighbour extends the export rectangle so the ROI itself cannot mask a missing clip.
it('matches a rotated G-force preview canvas even when the dot or trail leaves it', async () => {
  const g = createWidget('gForceDiagram')
  const neighbour = createWidget('customText')
  if (g.type !== 'gForceDiagram' || neighbour.type !== 'customText') throw new Error('widget fixture')
  Object.assign(g, { x: 0.25, y: 0.25, w: 0.25, h: 0.25, rotation: 17 })
  Object.assign(neighbour, { x: 0.8, y: 0.25, w: 0.1, h: 0.25 })
  Object.assign(neighbour.style, { text: '', backgroundOpacity: 0 })
  const sampler = { ...createTelemetrySampler(telemetry), hasImuData: true,
    gForceAt: (t: number) => ({ lateralG: t === 1000 ? 0.6 : 8, longitudinalG: 0 }),
    gForceHistoryAt: () => [{ cts: 950, lateralG: 8, longitudinalG: 0 }]
  }
  const renderer = await createFrameRenderer(width, height, [g, neighbour], sampler, null, 15, {}, {},
    20000, 0, 'Arial', undefined, undefined, undefined, true)
  const roi = renderer.roi
  expect(roi).toEqual({ x: 160, y: 90, width: 416, height: 90 })
  const local = createCanvas(160, 90)
  const ctx = local.getContext('2d')
  for (const cts of [1000, 1100]) {
    ctx.clearRect(0, 0, 160, 90)
    drawWidget(ctx as unknown as Canvas2DLike, g, { x: 0, y: 0, w: 160, h: 90 }, {
      trackPoints: [], bounds: sampler.bounds, dotPosition: sampler.positionAt(cts),
      speedMps: 0, elapsedMs: cts, cts, hasImuData: true, gForceReading: sampler.gForceAt(cts),
      gForceHistory: sampler.gForceHistoryAt(), projectFontFamily: 'Arial'
    })
    const expected = ctx.getImageData(0, 0, 160, 90).data
    const actual = renderer.renderFrame(cts, cts)
    let maxDifference = 0, escaped = 0
    for (let y = 0; y < 90; y++) for (let x = 0; x < roi.width; x++) {
      const i = (y * roi.width + x) * 4
      if (x >= 160) escaped += actual[i + 3]
      else for (let c = 0; c < 4; c++) {
        maxDifference = Math.max(maxDifference, Math.abs(actual[i + c] - expected[(y * 160 + x) * 4 + c]))
      }
    }
    expect(escaped).toBe(0)
    expect(maxDifference).toBeLessThanOrEqual(1)
  }
})
