/**
 * TypeScript declarations for the Construct UI SDK.
 *
 * The Construct platform injects `construct.*` globals into every app iframe.
 * Add this file to your app's `ui/` directory (or reference it in tsconfig)
 * to get full autocomplete and type checking.
 *
 * Usage:
 *   /// <reference path="./construct.d.ts" />
 *   // or copy this file as ui/construct.d.ts
 *
 * Kept in sync with
 * https://github.com/construct-computer/app-sdk/blob/main/src/construct-global.d.ts
 */

declare namespace construct {
  /**
   * Wait for the SDK bridge to be ready, then run the callback.
   * Always wrap your initialization code in this.
   *
   * @example
   * ```ts
   * construct.ready(() => {
   *   construct.ui.setTitle('My App');
   *   loadInitialState();
   * });
   * ```
   */
  function ready(callback: () => void): void;

  /** Call MCP tools registered by your app's server. */
  namespace tools {
    /**
     * Call a tool and get the full result.
     * @param name - Tool name (as registered in server.ts)
     * @param args - Tool arguments
     * @returns The raw tool result (content blocks array)
     */
    function call(
      name: string,
      args?: Record<string, unknown>,
    ): Promise<{
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }>;

    /**
     * Call a tool and get just the text result.
     * Concatenates all text content blocks.
     * @param name - Tool name
     * @param args - Tool arguments
     * @returns The text content of the result
     */
    function callText(
      name: string,
      args?: Record<string, unknown>,
    ): Promise<string>;
  }

  /**
   * Persistent state management.
   * State is a JSON object stored server-side that both the UI and the agent can read/write.
   * When the agent calls `set_app_state`, your `onUpdate` callback fires automatically.
   */
  namespace state {
    /** Read the current app state from the server. */
    function get<T = Record<string, unknown>>(): Promise<T>;

    /** Write new state to the server. Triggers `onUpdate` on all connected clients. */
    function set(state: Record<string, unknown>): Promise<{ ok: boolean }>;

    /**
     * Subscribe to state updates (from the agent or other tabs).
     * @param callback - Called with the new state whenever it changes
     */
    function onUpdate<T = Record<string, unknown>>(
      callback: (state: T) => void,
    ): void;
  }

  /** Control the app window. */
  namespace ui {
    /** Set the window title bar text. */
    function setTitle(title: string): Promise<void>;

    /** Get the current Construct theme. */
    function getTheme(): Promise<{
      mode: 'light' | 'dark';
      accent: string;
    }>;

    /** Close this app window. */
    function close(): Promise<void>;
  }

  /** Communicate with the Construct agent. */
  namespace agent {
    /**
     * Send a notification to the agent. This appears as a message
     * in the chat like `[App | your-app]: your message`.
     * The agent can then respond by reading/updating your app state.
     *
     * @param message - Natural language message for the agent
     */
    function notify(message: string): Promise<void>;
  }
}
