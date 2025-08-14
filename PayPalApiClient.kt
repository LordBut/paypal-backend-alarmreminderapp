package com.alarmreminderapp

import android.util.Log
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
            null
          }
        }
      } catch (e: IOException) {
        null
      } catch (e: Exception) {
        null
      }
    }
  }

  // ✅ Fetch subscription details and extract payerEmail
  suspend fun getSubscriptionDetails(subscriptionId: String): SubscriptionDetails? {
    return withContext(Dispatchers.IO) {
      try {
        val accessToken = getAccessToken()
        val url = "https://api-m.paypal.com/v1/billing/subscriptions/$subscriptionId"
        val request = Request.Builder()
          .url(url)
          .addHeader("Authorization", "Bearer $accessToken")
          .addHeader("Content-Type", "application/json")
          .build()

        client.newCall(request).execute().use { response ->
          if (!response.isSuccessful) {
            return@withContext null
          }

          val responseBody = response.body?.string() ?: return@withContext null
          val json = JSONObject(responseBody)

          val subscriber = json.optJSONObject("subscriber")
          val payerEmail = subscriber?.optString("email_address")

          return@withContext SubscriptionDetails(
            status = json.getString("status"),
            planId = json.getString("plan_id"),
            payerEmail = payerEmail
          )
        }
      } catch (e: Exception) {
        null
      }
    }
  }

  data class SubscriptionDetails(
    val status: String,
    val planId: String,
    val payerEmail: String?
  )

  suspend fun createSubscription(
    planId: String,
    tier: String,
    userId: String,
    email: String
  ): JSONObject? = withContext(Dispatchers.IO) {
    val accessToken = getAccessToken() ?: return@withContext null

    try {
      val requestBody = JSONObject().apply {
        put("planId", planId)
        put("userId", userId)
        put("tier", tier)
        put("userEmail", email)
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
          JSONObject(responseBody)
        } else {
          null
        }
      }
    } catch (e: IOException) {
      null
    } catch (e: Exception) {
      null
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
            true
          } else {
            false
          }
        }
      } catch (e: IOException) {
        false
      } catch (e: Exception) {
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
            true
          } else {
            false
          }
        }
      } catch (e: IOException) {
        false
      } catch (e: Exception) {
        false
      }
    }
  }
}
