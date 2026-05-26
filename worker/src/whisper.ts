/**
 * Audio transcription via Cloudflare Workers AI (Whisper).
 *
 * Modelo: @cf/openai/whisper-large-v3-turbo
 *   - Soporta 99 idiomas (forzamos español para mayor precisión)
 *   - ~10 segundos de audio se transcriben en <1s
 *   - Corre en el mismo edge que el worker (sin saltos de red externos)
 *   - Costo: prácticamente $0 a escala consultorio (10K req/día gratis)
 *
 * Uso:
 *   const text = await transcribeAudio(env, audioBuffer);
 *   if (text) console.log("Paciente dijo:", text);
 *
 * El initial_prompt incluye términos médicos y de cirugía plástica para
 * mejorar la precisión de transcripción de jergas y nombres comunes en el
 * contexto del consultorio.
 */
import type { Env } from "./env";

const MEDICAL_PROMPT =
  "Consulta médica con cirujano plástico Dr. David Duque en Bogotá. " +
  "Términos comunes: rinoplastia, mamoplastia de aumento, mastopexia, " +
  "abdominoplastia, lipoescultura, blefaroplastia, otoplastia, ritidoplastia, " +
  "valoración, agenda, cita, control, post-operatorio, anestesia, cicatriz, " +
  "Colsanitas, particular, miércoles, cotización.";

export async function transcribeAudio(
  env: Env,
  audioBuffer: ArrayBuffer,
): Promise<string | null> {
  if (!env.AI) {
    console.log("[whisper] no AI binding configured");
    return null;
  }

  // Whisper espera el audio como número[] (representación de Uint8Array).
  // Para audios típicos de WhatsApp (10-30s, ~50-300KB), la conversión es
  // trivial. Para audios mayores a 4MB, considerar trocear (no aplica al uso
  // típico de voice notes).
  if (audioBuffer.byteLength === 0) {
    console.log("[whisper] empty audio buffer");
    return null;
  }
  if (audioBuffer.byteLength > 25 * 1024 * 1024) {
    console.log(`[whisper] audio too large: ${audioBuffer.byteLength} bytes`);
    return null;
  }

  const audioArray = Array.from(new Uint8Array(audioBuffer));

  try {
    const t0 = Date.now();
    const result: any = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio: audioArray,
      task: "transcribe",
      language: "es",
      initial_prompt: MEDICAL_PROMPT,
      vad_filter: true,
    });
    const elapsed = Date.now() - t0;
    const text: string = result?.text?.toString().trim() ?? "";
    console.log(`[whisper] transcribed ${audioBuffer.byteLength}B in ${elapsed}ms: "${text.slice(0, 80)}"`);
    return text || null;
  } catch (e) {
    // Fallback: probar con el modelo base por si large-v3-turbo no está
    // disponible en la región del worker.
    console.log(`[whisper] large-v3-turbo failed: ${(e as Error).message}, trying base model`);
    try {
      const result: any = await env.AI.run("@cf/openai/whisper", {
        audio: audioArray,
      });
      const text: string = result?.text?.toString().trim() ?? "";
      console.log(`[whisper] base transcribed: "${text.slice(0, 80)}"`);
      return text || null;
    } catch (e2) {
      console.log(`[whisper] base also failed: ${(e2 as Error).message}`);
      return null;
    }
  }
}
