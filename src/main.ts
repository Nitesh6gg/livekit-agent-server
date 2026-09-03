import { ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.ts';

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env' });

export default defineAgent({
  entry: async (ctx) => {
    // Set up a voice AI pipeline using Sarvam STT/TTS and the LiveKit turn detector
    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // Uses the Sarvam plugin directly with your own SARVAM_API_KEY, rather than LiveKit Inference
      stt: new sarvam.STT({
        model: 'saaras:v3',
        languageCode: 'unknown', // auto-detect the language the user is speaking
        mode: 'transcribe',
      }),

      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // Uses the Sarvam plugin directly with your own SARVAM_API_KEY, rather than LiveKit Inference
      tts: new sarvam.TTS({
        model: 'bulbul:v3',
        speaker: 'shubh',
        targetLanguageCode: 'hi-IN', // replies are always spoken in Hindi; TTS has no auto-detect
      }),

      turnHandling: {
        // Turn detection determines when the user is speaking and when the agent should respond.
        // The LiveKit audio turn detector is a multimodal model that encodes the user's audio
        // directly to predict end of turn. It's built into the SDK (no extra plugin) and
        // AgentSession supplies the required VAD automatically.
        // See more at https://docs.livekit.io/agents/logic/turns/turn-detector/
        turnDetection: new inference.TurnDetector(),
        endpointing: {
          // Raised from the 500ms default to give Sarvam STT (slower over 8kHz phone audio)
          // more time to deliver its final transcript before the turn is committed. Without
          // this, late transcripts arrive after the turn already closed, invalidating an
          // in-progress response and causing an audible cutoff/restart.
          minDelay: 900,
        },
        // Adaptive interruptions use the turn detector to tell a real interruption from a
        // backchannel like "mhm" or "right", so the agent keeps talking through the latter.
        interruption: { mode: 'adaptive' },
        // Allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: { enabled: true },
      },

      // Expressive mode is disabled: it requires a LiveKit Inference TTS model that declares a
      // markup dialect (e.g. Fish Audio, Inworld, Cartesia, xAI), which Sarvam does not.
      expressive: false,
    });

    // Start the session, which initializes the voice pipeline and warms up the models
    // Note: no noiseCancellation is configured. Enhanced NC providers (ai-coustics, Krisp)
    // require either LiveKit Cloud or your own provider license key for self-hosted use,
    // and WebRTC's built-in NC is client-side only (doesn't cover SIP/telephony audio).
    await session.start({
      agent: createAgent(),
      room: ctx.room,
    });

    // // Add a virtual avatar to the session, if desired
    // // For other providers, see https://docs.livekit.io/agents/models/avatar/
    // const avatar = new anam.AvatarSession({
    //   personaConfig: {
    //     name: '...',
    //     avatarId: '...', // See https://docs.livekit.io/agents/models/avatar/plugins/anam
    //   },
    // });
    // // Start the avatar and wait for it to join
    // await avatar.start(session, ctx.room);

    // Join the room and connect to the user
    await ctx.connect();

    // Greet the user on joining
    session.generateReply({
      instructions: 'Greet the user in a helpful and friendly manner.',
    });
  },
});

// Run the agent server
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'survey-agent',
  }),
);
