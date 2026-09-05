import { recognizeRegions, type OcrWorkerFactory } from "./ocr";
import { characterAccuracy } from "../shared/text";

/**
 * Ten canvas samples the device reads back, scored against known text.
 *
 * This exists because OCR is the one perception stage whose failure is silent: a worker
 * that loads, runs, and returns confident nonsense looks exactly like a working one from
 * the outside. The samples are deliberately the kind of thing PrivAgent must read off a
 * real page - a chart label, an invoice total, a masked card number, a rendered button -
 * at the sizes and contrasts those actually appear at, including two low-contrast cases
 * that are where recognition degrades first.
 *
 * They are canvas renders, not photographs of screens. That is the honest limit of this
 * measurement: it establishes that the local OCR path works and how accurately it reads
 * crisply rendered UI text, which is the input it will actually be given, since the
 * source is always a screenshot of a composited page.
 */
export interface OcrSample {
  id: string;
  text: string;
  font: string;
  background: string;
  foreground: string;
  width: number;
  height: number;
}

export const OCR_SAMPLES: readonly OcrSample[] = [
  {
    id: "button-label",
    text: "Download Report",
    font: "600 20px Arial",
    background: "#ffffff",
    foreground: "#111111",
    width: 260,
    height: 44,
  },
  {
    id: "invoice-total",
    text: "Total due 12,480.00",
    font: "18px Georgia",
    background: "#ffffff",
    foreground: "#1a1a1a",
    width: 280,
    height: 40,
  },
  {
    id: "chart-axis",
    text: "Revenue Q3 2026",
    font: "16px Verdana",
    background: "#f4f4f4",
    foreground: "#333333",
    width: 240,
    height: 36,
  },
  {
    id: "masked-card",
    text: "Card ending 4242",
    font: "17px Courier New",
    background: "#ffffff",
    foreground: "#000000",
    width: 250,
    height: 38,
  },
  {
    id: "status-line",
    text: "Payment pending approval",
    font: "15px Tahoma",
    background: "#fff8e1",
    foreground: "#5d4037",
    width: 300,
    height: 34,
  },
  {
    id: "nav-item",
    text: "Settings",
    font: "600 22px Arial",
    background: "#1a5fb4",
    foreground: "#ffffff",
    width: 160,
    height: 46,
  },
  {
    id: "small-print",
    text: "Applies to all accounts",
    font: "13px Arial",
    background: "#ffffff",
    foreground: "#555555",
    width: 230,
    height: 30,
  },
  {
    id: "low-contrast",
    text: "Account holder name",
    font: "16px Arial",
    background: "#e8e8e8",
    foreground: "#8a8a8a",
    width: 260,
    height: 36,
  },
  {
    id: "reference-code",
    text: "Ref TXN 88317204",
    font: "17px Consolas",
    background: "#ffffff",
    foreground: "#222222",
    width: 250,
    height: 38,
  },
  {
    id: "dark-mode",
    text: "Upload statement",
    font: "18px Segoe UI",
    background: "#1e1e1e",
    foreground: "#ececec",
    width: 250,
    height: 40,
  },
];

export interface OcrSampleResult {
  id: string;
  expected: string;
  actual: string;
  accuracy: number;
  confidence: number;
}

export interface OcrSelfTestReport {
  samples: OcrSampleResult[];
  /** Mean character accuracy across every sample, 0-1. */
  meanAccuracy: number;
  /** Wall-clock milliseconds for the whole run, worker startup included. */
  millis: number;
}

/** Draws one sample, centred, on a fresh region of the strip. */
function drawSample(context: CanvasRenderingContext2D, sample: OcrSample, top: number): void {
  context.fillStyle = sample.background;
  context.fillRect(0, top, sample.width, sample.height);
  context.fillStyle = sample.foreground;
  context.font = sample.font;
  context.textBaseline = "middle";
  context.fillText(sample.text, 8, top + sample.height / 2);
}

/**
 * Renders every sample onto one canvas and reads them back.
 *
 * One canvas and one worker on purpose: this is the same shape as the real pass, where a
 * single screenshot carries several regions to read.
 */
export async function runOcrSelfTest(
  samples: readonly OcrSample[] = OCR_SAMPLES,
  workerFactory?: OcrWorkerFactory,
): Promise<OcrSelfTestReport> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(...samples.map((sample) => sample.width));
  canvas.height = samples.reduce((total, sample) => total + sample.height, 0);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable for the OCR self-test");

  const regions: { bbox: [number, number, number, number] }[] = [];
  let top = 0;
  for (const sample of samples) {
    drawSample(context, sample, top);
    regions.push({ bbox: [0, top, sample.width, sample.height] });
    top += sample.height;
  }

  const started = performance.now();
  const results = await recognizeRegions(canvas, regions, workerFactory);
  const millis = Math.round(performance.now() - started);

  const scored = results.map((result, index) => {
    const sample = samples[index]!;
    return {
      id: sample.id,
      expected: sample.text,
      actual: result.text,
      accuracy: characterAccuracy(sample.text, result.text),
      confidence: result.confidence,
    };
  });

  return {
    samples: scored,
    meanAccuracy:
      scored.reduce((total, sample) => total + sample.accuracy, 0) / (scored.length || 1),
    millis,
  };
}
