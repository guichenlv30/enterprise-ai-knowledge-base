declare module "pdf-parse" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }

  export default function pdfParse(dataBuffer: Buffer): Promise<PdfParseResult>;
}
