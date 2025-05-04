package com.alarmreminderapp.backend

import android.util.Log
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class PayPalApiClient {

  companion object {
    private const val TAG = "PayPalApiClient"
    private const val BACKEND_BASE_URL = "https://paypal-api-khmg.onrender.com/api/paypal"
    private const val CONTENT_TYPE = "application/json"
    private const val AUTHORIZATION = "Authorization"
  }

  private val client = OkHttpClient.Builder()
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .writeTimeout(30, TimeUnit.SECONDS)
    .build()

  private var cachedAccessToken: String? = null

  private suspend fun getAccessToken(): String? {
    return cachedAccessToken ?: withContext(Dispatchers.IO) {
      try {
        val request = Request.Builder()
          .url("$BACKEND_BASE_URL/token")
          .get()
          .build()

        client.newCall(request).execute().use { response ->
          val responseBody = response.body?.string() ?: ""
          if (response.isSuccessful) {
            val jsonResponse = JSONObject(responseBody)
            cachedAccessToken = jsonResponse.getString("access_token")
            cachedAccessToken
          } else {
            Log.e(TAG, "Token Error ${response.code}: $responseBody")
            null
          }
        }
      } catch (e: IOException) {
        Log.e(TAG, "Token IOException: ${e.message}")
        null
      } catch (e: Exception) {
        Log.e(TAG, "Token Exception: ${e.message}")
        null
      }
    }
  }

  suspend fun createSubscription(planId: String, tier: String): SubscriptionResponse? {
    return withContext(Dispatchers.IO) {
      val accessToken = getAccessToken() ?: return@withContext null
      val user = FirebaseAuth.getInstance().currentUser
      val userId = user?.uid ?: return@withContext null

      try {
        val requestBody = JSONObject().apply {
          put("plan_id", planId)
          put("custom_id", userId)
          put("subscriber", JSONObject().apply {
            put("email_address", user.email ?: "unknown@example.com")
          })
          put("application_context", JSONObject().apply {
            put("brand_name", "Alarm Reminder App")
            put("locale", "en-US")
            put("shipping_preference", "NO_SHIPPING")
            put("user_action", "SUBSCRIBE_NOW")
            put("return_url", "https://paypal-api-khmg.onrender.com/paypal/subscription/success?tier=$tier&plan_id=$planId")
            put("cancel_url", "https://paypal-api-khmg.onrender.com/subscription/cancel")
          })
        }

        val request = Request.Builder()
          .url("$BACKEND_BASE_URL/subscription")
          .post(requestBody.toString().toRequestBody(CONTENT_TYPE.toMediaTypeOrNull()))
          .header(AUTHORIZATION, "Bearer $accessToken")
          .header("Content-Type", CONTENT_TYPE)
          .build()

        client.newCall(request).execute().use { response ->
          val responseBody = response.body?.string() ?: ""
          if (response.isSuccessful) {
            val jsonResponse = JSONObject(responseBody)
            val approvalUrl = jsonResponse.getJSONArray("links")
              .let { links ->
                (0 until links.length())
                  .map { links.getJSONObject(it) }
                  .firstOrNull { it.getString("rel") == "approve" }
                  ?.getString("href")
              }

            SubscriptionResponse(
              subscriptionId = jsonResponse.getString("id"),
              approvalUrl = approvalUrl
            )
          } else {
            Log.e(TAG, "Create Subscription Error ${response.code}: $responseBody")
            null
          }
        }
      } catch (e: IOException) {
        Log.e(TAG, "Create Subscription IOException: ${e.message}")
        null
      } catch (e: Exception) {
        Log.e(TAG, "Create Subscription Exception: ${e.message}")
        null
      }
    }
  }

  suspend fun getSubscriptionStatus(subscriptionId: String): String? {
    return withContext(Dispatchers.IO) {
      val accessToken = getAccessToken() ?: return@withContext null

      try {
        val request = Request.Builder()
          .url("$BACKEND_BASE_URL/subscription/$subscriptionId")
          .get()
          .header(AUTHORIZATION, "Bearer $accessToken")
          .header("Content-Type", CONTENT_TYPE)
          .build()

        client.newCall(request).execute().use { response ->
          val responseBody = response.body?.string() ?: ""
          if (response.isSuccessful) {
            val jsonResponse = JSONObject(responseBody)
            jsonResponse.getString("status")
          } else {
            Log.e(TAG, "Get Status Error ${response.code}: $responseBody")
            null
          }
        }
      } catch (e: IOException) {
        Log.e(TAG, "Get Status IOException: ${e.message}")
        null
      } catch (e: Exception) {
        Log.e(TAG, "Get Status Exception: ${e.message}")
        null
      }
    }
  }

  suspend fun cancelSubscription(subscriptionId: String): Boolean {
    return withContext(Dispatchers.IO) {
      val accessToken = getAccessToken() ?: return@withContext false

      try {
        val request = Request.Builder()
          .url("$BACKEND_BASE_URL/subscription/$subscriptionId/cancel")
          .post("".toRequestBody(CONTENT_TYPE.toMediaTypeOrNull()))
          .header(AUTHORIZATION, "Bearer $accessToken")
          .header("Content-Type", CONTENT_TYPE)
          .build()

        client.newCall(request).execute().use { response ->
          if (response.isSuccessful) {
            Log.d(TAG, "✅ Subscription $subscriptionId cancelled successfully.")
            true
          } else {
            val responseBody = response.body?.string() ?: ""
            Log.e(TAG, "❌ Failed to cancel subscription $subscriptionId: ${response.code} - $responseBody")
            false
          }
        }
      } catch (e: IOException) {
        Log.e(TAG, "❌ Cancel Subscription IOException: ${e.message}")
        false
      } catch (e: Exception) {
        Log.e(TAG, "❌ Cancel Subscription Exception: ${e.message}")
        false
      }
    }
  }

  suspend fun notifySubscriptionSuccess(subscriptionId: String, planId: String, tier: String): Boolean {
    return withContext(Dispatchers.IO) {
      val accessToken = getAccessToken() ?: return@withContext false

      try {
        val json = JSONObject().apply {
          put("subscriptionId", subscriptionId)
          put("planId", planId)
          put("tier", tier)
        }

        val request = Request.Builder()
          .url("$BACKEND_BASE_URL/subscription/$subscriptionId/success")
          .post(json.toString().toRequestBody(CONTENT_TYPE.toMediaTypeOrNull()))
          .header(AUTHORIZATION, "Bearer $accessToken")
          .header("Content-Type", CONTENT_TYPE)
          .build()

        client.newCall(request).execute().use { response ->
          if (response.isSuccessful) {
            Log.d(TAG, "✅ Subscription $subscriptionId success notified.")
            true
          } else {
            val responseBody = response.body?.string() ?: ""
            Log.e(TAG, "❌ Failed to notify success: ${response.code} - $responseBody")
            false
          }
        }
      } catch (e: IOException) {
        Log.e(TAG, "❌ Notify Success IOException: ${e.message}")
        false
      } catch (e: Exception) {
        Log.e(TAG, "❌ Notify Success Exception: ${e.message}")
        false
      }
    }
  }

  suspend fun checkSubscriptionStatus(subscriptionId: String): Boolean {
    return withContext(Dispatchers.IO) {
      getSubscriptionStatus(subscriptionId) == "ACTIVE"
    }
  }
}
