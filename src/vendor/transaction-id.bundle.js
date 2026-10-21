(() => {
  // vendor/x-client-transaction-id/cubic.js
  var Cubic = class {
    /**
     * Creates a new Cubic instance
     * @param curves Array of curve control points
     */
    constructor(curves) {
      Object.defineProperty(this, "curves", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this.curves = curves;
    }
    /**
     * Calculates the interpolated value at a specific time point
     * @param time Normalized time value (0.0 to 1.0)
     * @returns Interpolated value
     */
    getValue(time) {
      let startGradient = 0;
      let endGradient = 0;
      let start = 0;
      let mid = 0;
      let end = 1;
      if (time <= 0) {
        if (this.curves[0] > 0) {
          startGradient = this.curves[1] / this.curves[0];
        } else if (this.curves[1] === 0 && this.curves[2] > 0) {
          startGradient = this.curves[3] / this.curves[2];
        }
        return startGradient * time;
      }
      if (time >= 1) {
        if (this.curves[2] < 1) {
          endGradient = (this.curves[3] - 1) / (this.curves[2] - 1);
        } else if (this.curves[2] === 1 && this.curves[0] < 1) {
          endGradient = (this.curves[1] - 1) / (this.curves[0] - 1);
        }
        return 1 + endGradient * (time - 1);
      }
      while (start < end) {
        mid = (start + end) / 2;
        const xEst = this.calculate(this.curves[0], this.curves[2], mid);
        if (Math.abs(time - xEst) < 1e-5) {
          return this.calculate(this.curves[1], this.curves[3], mid);
        }
        if (xEst < time) {
          start = mid;
        } else {
          end = mid;
        }
      }
      return this.calculate(this.curves[1], this.curves[3], mid);
    }
    /**
     * Calculates cubic bezier value with given control points
     * @param a First control point
     * @param b Second control point
     * @param m Parametric value (0.0 to 1.0)
     * @returns Calculated cubic bezier value
     * @private
     */
    calculate(a, b, m) {
      return 3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m;
    }
  };
  var cubic_default = Cubic;

  // vendor/x-client-transaction-id/errors.js
  var ClientTransactionError = class extends Error {
    /**
     * Creates a new ClientTransactionError.
     * @param message Error message
     * @param options Optional cause and error code
     */
    constructor(message, options = {}) {
      super(message, options.cause ? { cause: options.cause } : void 0);
      Object.defineProperty(this, "code", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this.name = new.target.name;
      this.code = options.code ?? "CLIENT_TRANSACTION_ERROR";
    }
  };
  var ClientTransactionInitializationError = class extends ClientTransactionError {
    /**
     * Creates a new ClientTransactionInitializationError.
     * @param message Error message
     * @param options Optional cause and error code
     */
    constructor(message, options = {}) {
      super(message, {
        code: options.code ?? "CLIENT_TRANSACTION_INITIALIZATION_ERROR",
        cause: options.cause
      });
    }
  };
  var OnDemandFileUrlResolutionError = class extends ClientTransactionInitializationError {
    constructor() {
      super("Unable to resolve the X ondemand chunk URL from the homepage runtime.", { code: "ONDEMAND_FILE_URL_RESOLUTION_ERROR" });
    }
  };
  var OnDemandFileFetchError = class extends ClientTransactionInitializationError {
    /**
     * Creates a new OnDemandFileFetchError.
     * @param url URL that was fetched
     * @param status HTTP status code
     * @param statusText HTTP status text
     */
    constructor(url, status, statusText) {
      super(`Unable to fetch the X ondemand chunk from "${url}": ${status} ${statusText}.`, { code: "ONDEMAND_FILE_FETCH_ERROR" });
      Object.defineProperty(this, "url", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "status", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "statusText", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this.url = url;
      this.status = status;
      this.statusText = statusText;
    }
  };
  var KeyByteIndicesExtractionError = class extends ClientTransactionInitializationError {
    constructor() {
      super("Unable to extract key byte indices from the X ondemand chunk.", { code: "KEY_BYTE_INDICES_EXTRACTION_ERROR" });
    }
  };
  var SiteVerificationKeyNotFoundError = class extends ClientTransactionInitializationError {
    constructor() {
      super("Unable to find the twitter-site-verification meta tag in the homepage document.", { code: "SITE_VERIFICATION_KEY_NOT_FOUND_ERROR" });
    }
  };
  var IndicesNotInitializedError = class extends ClientTransactionError {
    constructor() {
      super("ClientTransaction indices are not initialized. Call initialize() before generating animation data.", { code: "INDICES_NOT_INITIALIZED_ERROR" });
    }
  };
  var AnimationFrameDataError = class extends ClientTransactionInitializationError {
    /**
     * Creates a new AnimationFrameDataError.
     * @param rowIndex Row index that failed
     */
    constructor(rowIndex) {
      super(`Unable to build animation data for row ${rowIndex}. The homepage animation markup may have changed.`, { code: "ANIMATION_FRAME_DATA_ERROR" });
      Object.defineProperty(this, "rowIndex", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this.rowIndex = rowIndex;
    }
  };
  var ClientTransactionNotInitializedError = class extends ClientTransactionError {
    constructor() {
      super("ClientTransaction has not been initialized. Call initialize() or use ClientTransaction.create() first.", { code: "CLIENT_TRANSACTION_NOT_INITIALIZED_ERROR" });
    }
  };
  var InterpolationInputError = class extends ClientTransactionError {
    /**
     * Creates a new InterpolationInputError.
     * @param fromLength Length of the from array
     * @param toLength Length of the to array
     */
    constructor(fromLength, toLength) {
      super(`Interpolation requires arrays of the same length, but received ${fromLength} and ${toLength}.`, { code: "INTERPOLATION_INPUT_ERROR" });
      Object.defineProperty(this, "fromLength", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "toLength", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this.fromLength = fromLength;
      this.toLength = toLength;
    }
  };

  // vendor/x-client-transaction-id/interpolate.js
  function interpolate(fromList, toList, f) {
    if (fromList.length !== toList.length) {
      throw new InterpolationInputError(fromList.length, toList.length);
    }
    const out = [];
    for (let i = 0; i < fromList.length; i++) {
      out.push(interpolateNum(fromList[i], toList[i], f));
    }
    return out;
  }
  function interpolateNum(fromVal, toVal, f) {
    if (typeof fromVal === "number" && typeof toVal === "number") {
      return fromVal * (1 - f) + toVal * f;
    }
    if (typeof fromVal === "boolean" && typeof toVal === "boolean") {
      return f < 0.5 ? fromVal ? 1 : 0 : toVal ? 1 : 0;
    }
    return 0;
  }

  // vendor/x-client-transaction-id/rotation.js
  function convertRotationToMatrix(rotation) {
    const rad = rotation * Math.PI / 180;
    return [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)];
  }

  // vendor/x-client-transaction-id/utils.js
  function floatToHex(x) {
    const result = [];
    let quotient = Math.floor(x);
    let fraction = x - quotient;
    while (quotient > 0) {
      quotient = Math.floor(x / 16);
      const remainder = Math.floor(x - quotient * 16);
      if (remainder > 9) {
        result.unshift(String.fromCharCode(remainder + 55));
      } else {
        result.unshift(remainder.toString());
      }
      x = quotient;
    }
    if (fraction === 0) {
      return result.join("");
    }
    result.push(".");
    while (fraction > 0) {
      fraction *= 16;
      const integer = Math.floor(fraction);
      fraction -= integer;
      if (integer > 9) {
        result.push(String.fromCharCode(integer + 55));
      } else {
        result.push(integer.toString());
      }
    }
    return result.join("");
  }
  function isOdd(num) {
    if (num % 2) {
      return -1;
    }
    return 0;
  }

  // vendor/x-client-transaction-id/encoding.js
  function decodeBase64(value) {
    const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  function encodeBase64(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    return btoa(binary);
  }

  // vendor/x-client-transaction-id/transaction.js
  var ON_DEMAND_CHUNK_NAME = "ondemand.s";
  var INDICES_REGEX = /\(\w\[(\d{1,2})\],\s*16\)/g;
  var ON_DEMAND_FILE_HASH_REGEX = /(\d+):\s*["']ondemand\.s["'][\s\S]*?\}\)\[e\]\s*\|\|\s*e\)\s*\+\s*["']\.["']\s*\+\s*\(\{[\s\S]*?\b\1:\s*["']([a-zA-Z0-9_-]+)["']/s;
  function resolveOnDemandFileUrlFromRuntime(runtimeSource) {
    const onDemandFileMatch = ON_DEMAND_FILE_HASH_REGEX.exec(runtimeSource);
    if (!onDemandFileMatch) {
      return null;
    }
    return `https://abs.twimg.com/responsive-web/client-web/${ON_DEMAND_CHUNK_NAME}.${onDemandFileMatch[2]}a.js`;
  }
  var ClientTransaction = class _ClientTransaction {
    /**
     * Creates a new ClientTransaction instance
     * @param homePageDocument DOM Document object from X's responsive web app
     */
    constructor(homePageDocument) {
      Object.defineProperty(this, "DEFAULT_ROW_INDEX", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: null
      });
      Object.defineProperty(this, "DEFAULT_KEY_BYTES_INDICES", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: null
      });
      Object.defineProperty(this, "homePageDocument", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      Object.defineProperty(this, "key", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: null
      });
      Object.defineProperty(this, "keyBytes", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: null
      });
      Object.defineProperty(this, "animationKey", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: null
      });
      Object.defineProperty(this, "isInitialized", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: false
      });
      this.homePageDocument = homePageDocument;
    }
    /**
     * Initializes the ClientTransaction instance
     * Must be called after constructor and before using other methods
     * @returns Promise that resolves when initialization is complete
     * @throws Error if initialization fails
     */
    async initialize() {
      if (this.isInitialized)
        return;
      [this.DEFAULT_ROW_INDEX, this.DEFAULT_KEY_BYTES_INDICES] = await this.getIndices(this.homePageDocument);
      this.key = this.getKey(this.homePageDocument);
      this.keyBytes = this.getKeyBytes(this.key);
      this.animationKey = this.getAnimationKey(this.keyBytes, this.homePageDocument);
      this.isInitialized = true;
    }
    /**
     * Static factory method that creates and initializes a ClientTransaction instance
     * @param homePageDocument DOM Document object from X's responsive web app
     * @returns Initialized ClientTransaction instance
     */
    static async create(homePageDocument) {
      const instance = new _ClientTransaction(homePageDocument);
      await instance.initialize();
      return instance;
    }
    /**
     * Extracts key byte indices from the X responsive web app document
     * @param homePageDocument Optional document to use instead of stored one
     * @returns Tuple of [rowIndex, keyByteIndices]
     * @private
     */
    async getIndices(homePageDocument) {
      const keyByteIndices = [];
      const response = homePageDocument || this.homePageDocument;
      const onDemandFileUrl = this.getOnDemandFileUrl(response);
      const onDemandFileResponse = await fetch(onDemandFileUrl);
      if (!onDemandFileResponse.ok) {
        throw new OnDemandFileFetchError(onDemandFileUrl, onDemandFileResponse.status, onDemandFileResponse.statusText);
      }
      const responseText = await onDemandFileResponse.text();
      let match;
      INDICES_REGEX.lastIndex = 0;
      while ((match = INDICES_REGEX.exec(responseText)) !== null) {
        keyByteIndices.push(match[1]);
      }
      if (!keyByteIndices.length) {
        throw new KeyByteIndicesExtractionError();
      }
      const numericIndices = keyByteIndices.map((index) => parseInt(index, 10));
      return [numericIndices[0], numericIndices.slice(1)];
    }
    /**
     * Resolves the current ondemand chunk URL from webpack runtime metadata.
     * @param response Optional document to use instead of stored one
     * @returns Absolute URL for the ondemand chunk file
     * @private
     */
    getOnDemandFileUrl(response) {
      const document = response || this.homePageDocument;
      const runtimeSources = Array.from(document.querySelectorAll("script")).map((script) => script.textContent || "").filter((scriptText) => scriptText.includes(ON_DEMAND_CHUNK_NAME));
      runtimeSources.push(document.documentElement.outerHTML);
      for (const runtimeSource of runtimeSources) {
        const onDemandFileUrl = resolveOnDemandFileUrlFromRuntime(runtimeSource);
        if (onDemandFileUrl) {
          return onDemandFileUrl;
        }
      }
      throw new OnDemandFileUrlResolutionError();
    }
    /**
     * Extracts verification key from document
     * @param response Optional document to use instead of stored one
     * @returns X site verification key
     * @private
     */
    getKey(response) {
      response = response || this.homePageDocument;
      let content = "";
      const element = response.querySelector("[name='twitter-site-verification']");
      if (element) {
        content = element.getAttribute("content") ?? "";
      }
      if (!content) {
        throw new SiteVerificationKeyNotFoundError();
      }
      return content;
    }
    /**
     * Converts key string to byte array
     * @param key Base64 encoded key string
     * @returns Array of byte values
     * @private
     */
    getKeyBytes(key) {
      return Array.from(decodeBase64(key));
    }
    /**
     * Gets animation frames from document
     * @param response Optional document to use instead of stored one
     * @returns Array of frame elements
     * @private
     */
    getFrames(response) {
      response = response || this.homePageDocument;
      return Array.from(response.querySelectorAll("[id^='loading-x-anim']"));
    }
    /**
     * Parses SVG paths to extract coordinate arrays
     * @param keyBytes Key bytes from site verification
     * @param response Optional document to use
     * @param frames Optional frame elements if already fetched
     * @returns 2D array of frame coordinates
     * @private
     */
    get2dArray(keyBytes, response, frames) {
      if (!frames) {
        frames = this.getFrames(response);
      }
      if (!frames || !frames.length) {
        return [[]];
      }
      const frame = frames[keyBytes[5] % 4];
      const firstChild = frame.children[0];
      const targetChild = firstChild.children[1];
      const dAttr = targetChild.getAttribute("d");
      if (dAttr === null) {
        return [];
      }
      const items = dAttr.substring(9).split("C");
      return items.map((item) => {
        const cleaned = item.replace(/[^\d]+/g, " ").trim();
        const parts = cleaned === "" ? [] : cleaned.split(/\s+/);
        return parts.map((str) => parseInt(str, 10));
      });
    }
    /**
     * Calculates value within specified range
     * @param value Input value (0-255)
     * @param minVal Minimum output value
     * @param maxVal Maximum output value
     * @param rounding When true, uses Math.floor; when false, rounds to 2 decimal places
     * @returns Calculated value
     * @private
     */
    solve(value, minVal, maxVal, rounding) {
      const result = value * (maxVal - minVal) / 255 + minVal;
      return rounding ? Math.floor(result) : Math.round(result * 100) / 100;
    }
    /**
     * Generates animation key from frame data
     * @param frames Array of frame values
     * @param targetTime Target time for animation
     * @returns Animation key string
     * @private
     */
    animate(frames, targetTime) {
      const fromColor = frames.slice(0, 3).concat(1).map(Number);
      const toColor = frames.slice(3, 6).concat(1).map(Number);
      const fromRotation = [0];
      const toRotation = [this.solve(frames[6], 60, 360, true)];
      const remainingFrames = frames.slice(7);
      const curves = remainingFrames.map((item, counter) => this.solve(item, isOdd(counter), 1, false));
      const cubic = new cubic_default(curves);
      const val = cubic.getValue(targetTime);
      const color = interpolate(fromColor, toColor, val).map((value) => value > 0 ? value : 0);
      const rotation = interpolate(fromRotation, toRotation, val);
      const matrix = convertRotationToMatrix(rotation[0]);
      const strArr = color.slice(0, -1).map((value) => Math.round(value).toString(16));
      for (const value of matrix) {
        let rounded = Math.round(value * 100) / 100;
        if (rounded < 0) {
          rounded = -rounded;
        }
        const hexValue = floatToHex(rounded);
        strArr.push(hexValue.startsWith(".") ? `0${hexValue}`.toLowerCase() : hexValue || "0");
      }
      strArr.push("0", "0");
      const animationKey = strArr.join("").replace(/[.-]/g, "");
      return animationKey;
    }
    /**
     * Generates animation key used in transaction ID
     * @param keyBytes Key bytes from site verification
     * @param response Optional document to use
     * @returns Animation key string
     * @private
     */
    getAnimationKey(keyBytes, response) {
      const totalTime = 4096;
      if (this.DEFAULT_ROW_INDEX == null || this.DEFAULT_KEY_BYTES_INDICES == null) {
        throw new IndicesNotInitializedError();
      }
      const rowIndex = keyBytes[this.DEFAULT_ROW_INDEX] % 16;
      let frameTime = this.DEFAULT_KEY_BYTES_INDICES.reduce((num1, num2) => {
        return num1 * (keyBytes[num2] % 16);
      }, 1);
      frameTime = Math.round(frameTime / 10) * 10;
      const arr = this.get2dArray(keyBytes, response);
      if (!arr || !arr[rowIndex]) {
        throw new AnimationFrameDataError(rowIndex);
      }
      const frameRow = arr[rowIndex];
      const targetTime = frameTime / totalTime;
      const animationKey = this.animate(frameRow, targetTime);
      return animationKey;
    }
    /**
     * Generates a transaction ID for X API requests
     * @param method HTTP method (GET, POST, etc.)
     * @param path API endpoint path
     * @param response Optional document to use
     * @param key Optional key to use
     * @param animationKey Optional animation key to use
     * @param timeNow Optional timestamp (defaults to current time)
     * @returns Base64 encoded transaction ID with padding removed
     */
    async generateTransactionId(method, path, response, key, animationKey, timeNow) {
      if (!this.isInitialized) {
        throw new ClientTransactionNotInitializedError();
      }
      timeNow = timeNow || Math.floor((Date.now() - 1682924400 * 1e3) / 1e3);
      const timeNowBytes = [
        timeNow & 255,
        timeNow >> 8 & 255,
        timeNow >> 16 & 255,
        timeNow >> 24 & 255
      ];
      key = key || this.key || this.getKey(response);
      const keyBytes = key ? this.getKeyBytes(key) : this.keyBytes || this.getKeyBytes(key);
      animationKey = animationKey || this.animationKey || this.getAnimationKey(keyBytes, response);
      const data = `${method}!${path}!${timeNow}${_ClientTransaction.DEFAULT_KEYWORD}${animationKey}`;
      const encoder = new TextEncoder();
      const dataBuffer = encoder.encode(data);
      const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
      const hashBytes = Array.from(new Uint8Array(hashBuffer));
      const randomNum = Math.floor(Math.random() * 256);
      const bytesArr = [
        ...keyBytes,
        ...timeNowBytes,
        ...hashBytes.slice(0, 16),
        _ClientTransaction.ADDITIONAL_RANDOM_NUMBER
      ];
      const out = new Uint8Array([
        randomNum,
        ...bytesArr.map((item) => item ^ randomNum)
      ]);
      return encodeBase64(out).replace(/=/g, "");
    }
  };
  Object.defineProperty(ClientTransaction, "ADDITIONAL_RANDOM_NUMBER", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 3
  });
  Object.defineProperty(ClientTransaction, "DEFAULT_KEYWORD", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: "obfiowerehiring"
  });
  var transaction_default = ClientTransaction;

  // vendor/x-client-transaction-id/entry.js
  var transactionPromise = null;
  var initializedAt = 0;
  var CACHE_DURATION = 5 * 60 * 1e3;
  async function initializeTransaction(force = false) {
    if (!force && transactionPromise && Date.now() - initializedAt < CACHE_DURATION) return transactionPromise;
    transactionPromise = (async () => {
      const response = await fetch("https://x.com/i/jf/", {
        credentials: "include",
        cache: "no-store",
        headers: { accept: "text/html,application/xhtml+xml" }
      });
      if (!response.ok) throw new Error(`X \u7B7E\u540D\u6750\u6599\u8BF7\u6C42\u5931\u8D25\uFF08${response.status}\uFF09`);
      const html = await response.text();
      const document = new DOMParser().parseFromString(html, "text/html");
      const client = await transaction_default.create(document);
      initializedAt = Date.now();
      return client;
    })().catch((error) => {
      transactionPromise = null;
      throw error;
    });
    return transactionPromise;
  }
  async function generateTransactionId(method, path, forceRefresh = false) {
    const client = await initializeTransaction(forceRefresh);
    return client.generateTransactionId(method, path);
  }
  Object.defineProperty(window, "__XEF_GENERATE_TRANSACTION_ID", {
    configurable: true,
    value: generateTransactionId
  });
})();
