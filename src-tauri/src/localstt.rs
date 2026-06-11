//! Local speech-to-text: NVIDIA Parakeet TDT 0.6b v3 (int8 ONNX), run
//! in-process via transcribe-rs / ONNX Runtime. Fully self-contained — the
//! ONNX runtime is statically linked at build time (ort `download-binaries`),
//! no Python or system packages required. The ~670 MB model is downloaded
//! once from Hugging Face into the app data dir and loaded lazily on first
//! use (~2 GB RAM while resident; freed again via `unload`).

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use transcribe_rs::onnx::parakeet::ParakeetModel;
use transcribe_rs::onnx::Quantization;
use transcribe_rs::{SpeechModel, TranscribeOptions};

const HF_BASE: &str = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main";
pub const MODEL_ID: &str = "parakeet-tdt-0.6b-v3-int8";

/// (file name, size in bytes) — sizes are pinned so the aggregate download
/// progress bar has a total before every response arrived.
const MODEL_FILES: &[(&str, u64)] = &[
    ("encoder-model.int8.onnx", 652_183_999),
    ("decoder_joint-model.int8.onnx", 18_202_004),
    ("nemo128.onnx", 139_764),
    ("vocab.txt", 93_939),
];

fn total_size() -> u64 {
    MODEL_FILES.iter().map(|(_, s)| s).sum()
}

/// `~/Library/Application Support/SwarmZ/models/<model id>`
fn model_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("no app data dir")?;
    Ok(base.join("SwarmZ").join("models").join(MODEL_ID))
}

fn is_installed(dir: &PathBuf) -> bool {
    MODEL_FILES.iter().all(|(name, _)| dir.join(name).is_file())
}

static MODEL: once_cell::sync::Lazy<parking_lot::Mutex<Option<ParakeetModel>>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(None));
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalSttStatus {
    pub installed: bool,
    pub downloading: bool,
    /// model resident in RAM right now (~2 GB while loaded)
    pub loaded: bool,
    pub total_bytes: u64,
}

pub fn status() -> LocalSttStatus {
    let installed = model_dir().map(|d| is_installed(&d)).unwrap_or(false);
    LocalSttStatus {
        installed,
        downloading: DOWNLOADING.load(Ordering::SeqCst),
        loaded: MODEL.lock().is_some(),
        total_bytes: total_size(),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

/// Fetch all model files into the app data dir. Emits `localstt://progress`
/// (aggregate bytes) while running and `localstt://done` / `localstt://error`
/// at the end. Files land as `.part` first so a torn download never looks
/// installed; already-complete files are skipped (resume after cancel/crash).
pub async fn download(app: AppHandle) -> Result<(), String> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("download already running".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let result = download_inner(&app).await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    match &result {
        Ok(()) => {
            let _ = app.emit("localstt://done", ());
        }
        Err(e) => {
            let _ = app.emit("localstt://error", e.clone());
        }
    }
    result
}

async fn download_inner(app: &AppHandle) -> Result<(), String> {
    use futures_util::StreamExt;
    let dir = model_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let client = reqwest::Client::new();
    let total = total_size();
    let mut done_bytes: u64 = 0;
    let mut last_emit: u64 = 0;
    for (name, size) in MODEL_FILES {
        let dest = dir.join(name);
        // a finished file from a previous (cancelled) run — keep it
        if dest.metadata().map(|m| m.len() == *size).unwrap_or(false) {
            done_bytes += size;
            continue;
        }
        let resp = client
            .get(format!("{HF_BASE}/{name}"))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("download of {name} failed: HTTP {}", resp.status()));
        }
        let part = dir.join(format!("{name}.part"));
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if CANCEL.load(Ordering::SeqCst) {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Err("cancelled".into());
            }
            let chunk = chunk.map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
            done_bytes += chunk.len() as u64;
            // throttle progress events to every ~2 MB
            if done_bytes - last_emit > 2_000_000 {
                last_emit = done_bytes;
                let _ = app.emit(
                    "localstt://progress",
                    DownloadProgress {
                        downloaded: done_bytes,
                        total,
                    },
                );
            }
        }
        drop(file);
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn cancel_download() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Delete the model from disk (and RAM, if loaded).
pub fn remove() -> Result<(), String> {
    *MODEL.lock() = None;
    let dir = model_dir()?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Drop the resident model (frees ~2 GB; next transcription reloads it).
pub fn unload() {
    *MODEL.lock() = None;
}

/// Transcribe one segment of 16 kHz mono 16-bit PCM (base64, no WAV header —
/// the webview already decoded/resampled the recording). Loads the model on
/// first use and keeps it resident for fast follow-up dictations.
pub fn transcribe(pcm_b64: &str) -> Result<crate::openrouter::TranscriptionResult, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pcm_b64)
        .map_err(|e| e.to_string())?;
    let samples: Vec<f32> = bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect();
    let seconds = samples.len() as f64 / 16000.0;
    let mut guard = MODEL.lock();
    if guard.is_none() {
        let dir = model_dir()?;
        if !is_installed(&dir) {
            return Err("local speech model not installed".into());
        }
        let model =
            ParakeetModel::load(&dir, &Quantization::Int8).map_err(|e| e.to_string())?;
        *guard = Some(model);
    }
    let model = guard.as_mut().expect("model loaded above");
    let result = model
        .transcribe(&samples, &TranscribeOptions::default())
        .map_err(|e| e.to_string())?;
    Ok(crate::openrouter::TranscriptionResult {
        text: result.text,
        seconds,
        cost: 0.0,
    })
}
