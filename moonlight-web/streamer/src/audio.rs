use std::sync::Weak;

use log::{debug, error, warn};
use moonlight_common::stream::{
    audio::AudioDecoder,
    bindings::{AudioConfig, Capabilities, OpusMultistreamConfig},
};

use crate::StreamConnection;

pub(crate) struct StreamAudioDecoder {
    pub(crate) stream: Weak<StreamConnection>,
}

impl AudioDecoder for StreamAudioDecoder {
    fn setup(
        &mut self,
        audio_config: AudioConfig,
        stream_config: OpusMultistreamConfig,
        _ar_flags: i32,
    ) -> i32 {
        let Some(stream) = self.stream.upgrade() else {
            warn!("Failed to setup audio because stream is deallocated");
            return -1;
        };

        {
            let mut stream_info = stream.stream_setup.blocking_lock();
            stream_info.audio = Some(stream_config.clone());
        }

        // Setup audio on all peer transports
        stream.runtime.clone().block_on(async move {
            let transports = stream.peer_transports.read().await;
            if transports.is_empty() {
                error!("Failed to setup audio because no transports are connected!");
                return -1;
            }

            let mut result = 0i32;
            for (_peer_id, transport) in transports.iter() {
                let r = transport.sender.setup_audio(audio_config, stream_config.clone()).await;
                if r != 0 {
                    result = r;
                }
            }
            result
        })
    }

    fn start(&mut self) {}
    fn stop(&mut self) {}

    fn decode_and_play_sample(&mut self, data: &[u8]) {
        let Some(stream) = self.stream.upgrade() else {
            warn!("Failed to send audio sample because stream is deallocated");
            return;
        };

        stream.runtime.clone().block_on(async move {
            let transports = stream.peer_transports.read().await;

            if transports.is_empty() {
                debug!("Dropping audio packet because no transports are connected");
                return;
            }

            // Send to all peer transports
            for (peer_id, transport) in transports.iter() {
                if let Err(err) = transport.sender.send_audio_sample(data).await {
                    warn!("Failed to send audio sample to peer {:?}: {err}", peer_id);
                }
            }
        });
    }

    fn config(&self) -> AudioConfig {
        AudioConfig::STEREO
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::empty()
    }
}
