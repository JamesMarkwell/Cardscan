package expo.modules.ocr

import android.graphics.Bitmap
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * On-device text recognition as an Expo module.
 *
 * Written against the Expo Modules API, like ExpoOnnx, so it works on the New
 * Architecture. The scan pipeline hands it a small crop of the card (the strip
 * that holds the printed serial number) and reads the lines of text back.
 */
class ExpoOcrModule : Module() {
  // Created on first use: loading the model is not free, and most launches never scan.
  private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

  override fun definition() = ModuleDefinition {
    Name("ExpoOcr")

    /**
     * Recognise the text in an image given as packed ARGB pixels (row-major,
     * `width * height` of them) and return each line found, in reading order.
     * Pixels arrive as a plain array because Expo's converter for an IntArray
     * parameter takes a JS array.
     */
    AsyncFunction("recognise") { pixels: IntArray, width: Int, height: Int ->
      require(width > 0 && height > 0 && pixels.size >= width * height) {
        "Expected $width x $height pixels but got ${pixels.size}"
      }
      val bitmap = Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888)
      try {
        // Expo runs an AsyncFunction off the JS thread, so blocking on the task is fine.
        val result = Tasks.await(recognizer.process(InputImage.fromBitmap(bitmap, 0)))
        result.textBlocks.flatMap { block -> block.lines.map { line -> line.text } }
      } finally {
        bitmap.recycle()
      }
    }
  }
}
