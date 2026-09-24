/**
 * Local Screenshot Sanitizer
 * Renders solid blackout masking bars over sensitive coordinates
 * on an OffscreenCanvas before the image leaves the client environment.
 */

export class ScreenshotSanitizer {
  constructor() {
    this.maskColor = '#000000';
    this.badgeColor = '#ef4444';
  }

  /**
   * Redacts sensitive regions from a screenshot data URL.
   * @param {string} screenshotDataUrl - Base64 PNG/WebP data URL
   * @param {Array<{ bbox: number[], sensitive: boolean, semantic_type?: string }>} elements - DOM elements with coordinates
   * @param {{ width: number, height: number }} viewport - Viewport dimensions
   * @returns {Promise<string>} Redacted screenshot as base64 data URL
   */
  async redactScreenshot(screenshotDataUrl, elements, viewport, privacyAudit = {}) {
    const failClosedPlaceholder = async (maskedCount = 0) => {
      try {
        const w = 640; const h = 360;
        if (typeof OffscreenCanvas !== 'undefined') {
          const c = new OffscreenCanvas(w, h);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = '#ffffff'; ctx.font = 'bold 18px sans-serif';
          ctx.fillText(`Screenshot withheld (${maskedCount} masked regions)`, 20, h / 2);
          if (c.convertToBlob) return await this._blobToDataURL(await c.convertToBlob({ type: 'image/webp', quality: 0.8 }));
          if (c.toDataURL) return c.toDataURL('image/webp', 0.8);
        }
      } catch { /* use opaque pixel fallback */ }
      return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    };

    // If text PII has no location, or a canvas/video may contain text without
    // accessible DOM, the only safe image is a neutral placeholder.
    if (privacyAudit.coverageEstablished !== true || privacyAudit.unlocatedSensitiveText || privacyAudit.opaqueVisualSurface) {
      return failClosedPlaceholder(privacyAudit.maskedCount || 0);
    }
    if (!screenshotDataUrl || !Array.isArray(elements) || elements.length === 0) {
      return failClosedPlaceholder(0);
    }

    const sensitiveElements = elements.filter(el => el.sensitive && el.bbox && el.bbox.length === 4);

    // Fail closed: if redaction is impossible, never return the unredacted
    // image. Return a neutral placeholder so the VLM still receives layout
    // signal without any sensitive pixels.
    try {
      // In browser extension environment, create bitmap or image
      let imageBitmap;
      if (typeof createImageBitmap !== 'undefined') {
        const response = await fetch(screenshotDataUrl);
        const blob = await response.blob();
        imageBitmap = await createImageBitmap(blob);
      } else {
        // Node/unit-test env without image decoding: never return raw pixels.
        return await failClosedPlaceholder(sensitiveElements.length);
      }

      const imgWidth = imageBitmap.width;
      const imgHeight = imageBitmap.height;

      // Calculate scale factor between screenshot pixels and CSS pixels
      const scaleX = viewport?.width ? imgWidth / viewport.width : 1;
      const scaleY = viewport?.height ? imgHeight / viewport.height : 1;

      // Use OffscreenCanvas if available
      let canvas, ctx;
      if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(imgWidth, imgHeight);
        ctx = canvas.getContext('2d');
      } else if (typeof document !== 'undefined' && document.createElement) {
        canvas = document.createElement('canvas');
        canvas.width = imgWidth;
        canvas.height = imgHeight;
        ctx = canvas.getContext('2d');
      } else {
        return await failClosedPlaceholder();
      }

      // Draw original image
      ctx.drawImage(imageBitmap, 0, 0);

      // Redact each sensitive region
      for (const el of sensitiveElements) {
        const [x, y, w, h] = el.bbox;
        const drawX = Math.max(0, (x - 3) * scaleX);
        const drawY = Math.max(0, (y - 3) * scaleY);
        const drawW = (w + 6) * scaleX;
        const drawH = (h + 6) * scaleY;

        // Draw solid blackout mask
        ctx.fillStyle = this.maskColor;
        ctx.fillRect(drawX, drawY, drawW, drawH);

        // Draw subtle border and "[REDACTED]" label for VLM context
        ctx.strokeStyle = '#333333';
        ctx.lineWidth = 2 * scaleX;
        ctx.strokeRect(drawX, drawY, drawW, drawH);

        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.max(12, Math.floor(11 * scaleY))}px sans-serif`;
        const label = `[REDACTED ${el.semantic_type || 'SECRET'}]`;
        ctx.fillText(label, drawX + (6 * scaleX), drawY + (drawH / 2) + (4 * scaleY));
      }

      // Export redacted image as compressed WebP or JPEG
      if (canvas.convertToBlob) {
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
        return await this._blobToDataURL(blob);
      } else if (canvas.toDataURL) {
        return canvas.toDataURL('image/webp', 0.8);
      }

      return await failClosedPlaceholder();
    } catch (err) {
      console.warn('Screenshot redaction failed closed (placeholder returned):', err);
      return await failClosedPlaceholder();
    }
  }

  _blobToDataURL(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  _mockRedactionDataUrl(originalUrl, count) {
    // Used in unit-test/Node runner environment where Canvas/ImageBitmap is mocked
    return `${originalUrl}#redacted_${count}_regions`;
  }
}

export const defaultScreenshotSanitizer = new ScreenshotSanitizer();
