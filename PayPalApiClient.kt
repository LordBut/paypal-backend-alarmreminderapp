package com.alarmreminderapp.backend

import android.util.Log
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class PayPalApiClient {

  companion object {
    private const val TAG = "PayPalApiClient"
    private const val BACKEND_BASE_URL = "https://paypal-api-khmg.onrender.com/api/paypal"
  }

  private val client = OkHttpClient.Builder()
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .writeTimeout(30, TimeUnit.SECONDS)
    .build()

  private suspend fun getAccessToken(): String? {
    return withContext(Dispatchers.IO) {
      try {
        val request = Request.Builder()
          .url("$BACKEND_BASE_URL/token")
          .get()
          .build()

        val response = client.newCall(request).execute()
        val responseBody = response.body?.string() ?: ""

        if (response.isSuccessful) {
          val jsonResponse = JSONObject(responseBody)
          jsonResponse.getString("access_token")
        } else {
          Log.e(TAG, "Token Error ${response.code}: $responseBody")
          null
        }
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
          .post(requestBody.toString().toRequestBody("application/json".toMediaTypeOrNull()))
          .header("Authorization", "Bearer $accessToken")
          .header("Content-Type", "application/json")
          .build()

        val response = client.newCall(request).execute()
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
          .header("Authorization", "Bearer $accessToken")
          .header("Content-Type", "application/json")
          .build()

        val response = client.newCall(request).execute()
        if (response.isSuccessful) {
          val jsonResponse = JSONObject(response.body?.string() ?: "")
          jsonResponse.getString("status")
        } else {
          Log.e(TAG, "Get Status Error: ${response.message}")
          null
        }
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
          .post("".toRequestBody("application/json".toMediaTypeOrNull()))
          .header("Authorization", "Bearer $accessToken")
          .header("Content-Type", "application/json")
          .build()

        val response = client.newCall(request).execute()
        if (response.isSuccessful) {
          Log.d(TAG, "✅ Subscription $subscriptionId cancelled successfully.")
          true
        } else {
          Log.e(TAG, "❌ Failed to cancel subscription $subscriptionId: ${response.message}")
          false
        }
      } catch (e: Exception) {
        Log.e(TAG, "❌ Exception cancelling subscription: ${e.message}")
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
          .post(json.toString().toRequestBody("application/json".toMediaTypeOrNull()))
          .header("Authorization", "Bearer $accessToken")
          .header("Content-Type", "application/json")
          .build()

        val response = client.newCall(request).execute()
        if (response.isSuccessful) {
          Log.d(TAG, "✅ Subscription $subscriptionId success notified.")
          true
        } else {
          Log.e(TAG, "❌ Failed to notify success: ${response.message}")
          false
        }
      } catch (e: Exception) {
        Log.e(TAG, "❌ Exception notifying success: ${e.message}")
        false
      }
    }
  }

  suspend fun CheckSubscriptionStatus(subscriptionId: String): Boolean {
    return withContext(Dispatchers.IO) {
      getSubscriptionStatus(subscriptionId) == "ACTIVE"
    }
  }
}
