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
    private const val PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com"
    private const val CLIENT_ID = "AeLm8ttAP24tLByr4oq9KdAxt6HVKbPgz1p0_FmKHTEq7DrPMaXpc9HLs1m5-A_S-NN0xxCHRt2IkMc7"
    private const val CLIENT_SECRET = "EI3vEY29BLFvu257va0RVm5U-ced2BpPFAr0UvQswqwmAQunqeVSy5yysOikHea4IFr_x7-ybJiFnave"
    private const val TAG = "PayPalApiClient"
  }

  private val client = OkHttpClient.Builder()
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .writeTimeout(30, TimeUnit.SECONDS)
    .build()

  private suspend fun getAccessToken(): String? {
    return withContext(Dispatchers.IO) {
      try {
        val credentials = android.util.Base64.encodeToString(
          "$CLIENT_ID:$CLIENT_SECRET".toByteArray(),
          android.util.Base64.NO_WRAP
        )
        val requestBody = "grant_type=client_credentials"
          .toRequestBody("application/x-www-form-urlencoded".toMediaTypeOrNull())

        val request = Request.Builder()
          .url("$PAYPAL_BASE_URL/v1/oauth2/token")
          .post(requestBody)
          .header("Authorization", "Basic $credentials")
          .header("Accept", "application/json")
          .header("Content-Type", "application/x-www-form-urlencoded")
          .build()

        val response = client.newCall(request).execute()
        val responseBody = response.body?.string() ?: ""

        if (response.isSuccessful) {
          val jsonResponse = JSONObject(responseBody)
          return@withContext jsonResponse.getString("access_token")
        } else {
          Log.e(TAG, "Token Error ${response.code}: $responseBody")
          return@withContext null
        }
      } catch (e: Exception) {
        Log.e(TAG, "Token Exception: ${e.message}")
        return@withContext null
      }
    }
  }

  suspend fun createSubscription(planId: String, tier: String): SubscriptionResponse? {
    return withContext(Dispatchers.IO) {
      val accessToken = getAccessToken() ?: return@withContext null
      val userId = FirebaseAuth.getInstance().currentUser?.uid ?: return@withContext null

      try {
        val requestBody = JSONObject().apply {
          put("plan_id", planId)
          put("custom_id", userId)
          put("subscriber", JSONObject().apply {
            put("email_address", FirebaseAuth.getInstance().currentUser?.email ?: "unknown@example.com")
          })
          put("application_context", JSONObject().apply {
            put("brand_name", "Alarm Reminder App")
            put("locale", "en-US")
            put("shipping_preference", "NO_SHIPPING")
            put("user_action", "SUBSCRIBE_NOW")

            // ⬇️ Updated to go through your Render backend
            put("return_url", "https://paypal-api-khmg.onrender.com/paypal/subscription/success?tier=$tier")
            put("cancel_url", "https://paypal-api-khmg.onrender.com/paypal/subscription/cancel")
          })
        }

        val request = Request.Builder()
          .url("$PAYPAL_BASE_URL/v1/billing/subscriptions")
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

          return@withContext SubscriptionResponse(
            subscriptionId = jsonResponse.getString("id"),
            approvalUrl = approvalUrl
          )
        } else {
          Log.e(TAG, "Create Subscription Error ${response.code}: $responseBody")
          return@withContext null
        }
      } catch (e: Exception) {
        Log.e(TAG, "Create Subscription Exception: ${e.message}")
        return@withContext null
      }
    }
  }

  suspend fun getSubscriptionStatus(subscriptionId: String): String? {
    return withContext(Dispatchers.IO) {
      val accessToken = getAccessToken() ?: return@withContext null

      try {
        val request = Request.Builder()
          .url("$PAYPAL_BASE_URL/v1/billing/subscriptions/$subscriptionId")
          .get()
          .header("Authorization", "Bearer $accessToken")
          .header("Content-Type", "application/json")
          .build()

        val response = client.newCall(request).execute()
        if (response.isSuccessful) {
          val jsonResponse = JSONObject(response.body?.string() ?: "")
          return@withContext jsonResponse.getString("status")
        } else {
          Log.e(TAG, "Get Status Error: ${response.message}")
          return@withContext null
        }
      } catch (e: Exception) {
        Log.e(TAG, "Get Status Exception: ${e.message}")
        return@withContext null
      }
    }
  }

  suspend fun CheckSubscriptionStatus(subscriptionId: String): Boolean {
    return withContext(Dispatchers.IO) {
      val status = getSubscriptionStatus(subscriptionId)
      return@withContext status == "ACTIVE"
    }
  }

   suspend fun cancelSubscription(subscriptionId: String): Boolean {
    return withContext(Dispatchers.IO) {
      val accessToken = getAccessToken() ?: return@withContext false

      try {
        val request = Request.Builder()
          .url("$PAYPAL_BASE_URL/v1/billing/subscriptions/$subscriptionId/cancel")
          .post("".toRequestBody("application/json".toMediaTypeOrNull()))
          .header("Authorization", "Bearer $accessToken")
          .header("Content-Type", "application/json")
          .build()

        val response = client.newCall(request).execute()
        if (response.isSuccessful) {
          Log.d(TAG, "✅ Subscription $subscriptionId cancelled successfully.")
          return@withContext true
        } else {
          Log.e(TAG, "❌ Failed to cancel subscription $subscriptionId: ${response.message}")
          return@withContext false
        }
      } catch (e: Exception) {
        Log.e(TAG, "❌ Exception cancelling subscription: ${e.message}")
        return@withContext false
      }
    }
  }
}
