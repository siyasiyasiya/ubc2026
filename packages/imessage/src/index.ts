/**
 * @gta/imessage — Photon imessage-kit adapter (DECIDED chat provider).
 *
 * SKELETON. The real adapter implements the core `ChatPort` against
 * `@photon-ai/imessage-kit` (self-hosted on a Mac with Full Disk Access):
 *   - postMessage       -> sdk.send(chatId, text)
 *   - postImage         -> sdk.send(chatId, { images: [path] })
 *   - sendDirectMessage -> sdk.send(handle, text)
 *   - onMessage         -> sdk.startWatching({ onMessage, onGroupMessage })
 *   - onReaction        -> reaction events from the watcher (👍 tapback = "like")
 *
 * Not wired yet — pending the decision on whether to install the SDK now.
 */

import type {
  ChatPort,
  ImageRef,
  IncomingMessage,
  IncomingReaction,
  MessageRef,
  Unsubscribe,
} from "@gta/core";

const NOT_IMPLEMENTED = "not implemented: @gta/imessage skeleton — wire @photon-ai/imessage-kit";

export interface PhotonChatPortConfig {
  /** Path overrides, concurrency, logging — forwarded to IMessageSDK config. */
  sdkConfig?: unknown;
}

/** STUB implementation of ChatPort. Replace method bodies with imessage-kit calls. */
export class PhotonChatPort implements ChatPort {
  constructor(_config: PhotonChatPortConfig = {}) {}

  async postMessage(_chatId: string, _text: string): Promise<MessageRef> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async postImage(_chatId: string, _image: ImageRef, _caption?: string): Promise<MessageRef> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async sendDirectMessage(_handle: string, _text: string): Promise<MessageRef> {
    throw new Error(NOT_IMPLEMENTED);
  }
  onMessage(_handler: (msg: IncomingMessage) => void): Unsubscribe {
    throw new Error(NOT_IMPLEMENTED);
  }
  onReaction(_handler: (reaction: IncomingReaction) => void): Unsubscribe {
    throw new Error(NOT_IMPLEMENTED);
  }
}
