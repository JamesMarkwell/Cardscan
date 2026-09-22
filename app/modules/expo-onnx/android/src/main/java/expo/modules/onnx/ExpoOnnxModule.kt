package expo.modules.onnx

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.FloatBuffer
import java.util.UUID

/**
 * On-device ONNX Runtime inference as an Expo module.
 *
 * Written against the Expo Modules API, which is New Architecture / bridgeless
 * native — unlike onnxruntime-react-native, which used the removed legacy
 * bridge and crashed the app at startup on React Native 0.86. CollectorVision's
 * ONNX models run here unchanged.
 *
 * Sessions are held by an opaque id so the JS side can create, run and release
 * them without marshalling native handles.
 */
class ExpoOnnxModule : Module() {
  private val environment: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
  private val sessions = mutableMapOf<String, OrtSession>()

  override fun definition() = ModuleDefinition {
    Name("ExpoOnnx")

    // Load a model from a filesystem path and return a session id.
    AsyncFunction("create") { path: String ->
      val options = OrtSession.SessionOptions()
      val session = environment.createSession(path, options)
      val id = UUID.randomUUID().toString()
      sessions[id] = session
      id
    }

    AsyncFunction("inputNames") { id: String ->
      sessions[id]?.inputNames?.toList() ?: emptyList<String>()
    }

    AsyncFunction("outputNames") { id: String ->
      sessions[id]?.outputNames?.toList() ?: emptyList<String>()
    }

    /**
     * Run a single-input model. The input is a flat float array plus its dims;
     * outputs come back as { name: { data: FloatArray, dims: IntArray } }. The
     * models here have small outputs (8, 1, 1 for the detector; 128 for the
     * embedder), so returning plain arrays is cheap.
     */
    AsyncFunction("run") { id: String, inputName: String, data: FloatArray, dims: IntArray, requested: List<String> ->
      val session = sessions[id] ?: throw IllegalStateException("No ONNX session $id")
      val shape = LongArray(dims.size) { dims[it].toLong() }

      val inputTensor = OnnxTensor.createTensor(environment, FloatBuffer.wrap(data), shape)
      try {
        session.run(mapOf(inputName to inputTensor)).use { results ->
          val names = if (requested.isEmpty()) session.outputNames.toList() else requested
          val out = HashMap<String, Map<String, Any>>()
          for (name in names) {
            val tensor = results.get(name).orElseThrow { IllegalStateException("No output $name") } as OnnxTensor
            val buffer = tensor.floatBuffer
            val floats = FloatArray(buffer.remaining())
            buffer.get(floats)
            val outDims = tensor.info.shape.map { it.toInt() }
            out[name] = mapOf("data" to floats, "dims" to outDims)
          }
          out
        }
      } finally {
        inputTensor.close()
      }
    }

    AsyncFunction("release") { id: String ->
      sessions.remove(id)?.close()
    }
  }
}
