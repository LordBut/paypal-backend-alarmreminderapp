package com.alarmreminderapp.backend

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.Observer
import com.alarmreminderapp.R
import com.alarmreminderapp.backend.SubscriptionResponse
import com.alarmreminderapp.backend.PayPalApiClient // Ensure you have an API client to fetch subscription status

class PayPalSubscriptionActivity : AppCompatActivity() {

  companion object {
    const val EXTRA_PLAN_ID = "PAYPAL_PLAN_ID"
    const val EXTRA_TIER_NAME = "PAYPAL_TIER_NAME"
    const val EXTRA_RESULT_CONFIRMATION = "PAYPAL_RESULT_CONFIRMATION"
    const val APP_SCHEME = "alarmreminderapp" // Custom deep link scheme
  }

  private val viewModel: PayPalSubscriptionViewModel by viewModels()
  private var subscriptionId: String? = null // Store subscription ID

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_paypal_subscription)

    val cancelButton: Button = findViewById(R.id.cancelButton)
    val subscriptionDetailsTextView: TextView = findViewById(R.id.subscriptionDetailsTextView)

    cancelButton.setOnClickListener {
      Toast.makeText(this, "Subscription process canceled.", Toast.LENGTH_SHORT).show()
      finish()
    }

    subscriptionDetailsTextView.text = "Initiating PayPal subscription..."

    val planId = intent.getStringExtra(EXTRA_PLAN_ID)
    val tierName = intent.getStringExtra(EXTRA_TIER_NAME)

    if (planId != null && tierName != null) {
      viewModel.startSubscription(planId)

      // Observe LiveData from ViewModel
      viewModel.subscriptionResponse.observe(this, Observer { response ->
        handleSubscriptionResponse(response)
      })
    } else {
      Toast.makeText(this, "Invalid subscription details.", Toast.LENGTH_SHORT).show()
      finish()
    }
  }

  private fun handleSubscriptionResponse(response: SubscriptionResponse?) {
    if (response?.approvalUrl != null && response.subscriptionId != null) {
      subscriptionId = response.subscriptionId // Store Subscription ID

      // Open the approval URL using Chrome Custom Tabs for a smoother experience
      val customTabsIntent = CustomTabsIntent.Builder().build()
      customTabsIntent.launchUrl(this, Uri.parse(response.approvalUrl))
    } else {
      Toast.makeText(this, "Failed to retrieve approval URL.", Toast.LENGTH_SHORT).show()
      finish()
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    intent.data?.let { uri ->
      if (uri.scheme == APP_SCHEME) {
        when (uri.path) {
          "/subscription/success" -> checkSubscriptionStatus()
          "/subscription/cancel" -> handleSubscriptionCancel()
          else -> handleSubscriptionError()
        }
      }
    }
  }

  private fun checkSubscriptionStatus() {
    if (subscriptionId == null) {
      Toast.makeText(this, "No subscription ID found.", Toast.LENGTH_SHORT).show()
      finish()
      return
    }

    PayPalApiClient.checkSubscriptionStatus(subscriptionId!!) { status ->
      when (status) {
        "ACTIVE" -> handleSubscriptionSuccess()
        "APPROVAL_PENDING" -> Toast.makeText(this, "Subscription still pending approval.", Toast.LENGTH_SHORT).show()
        "CANCELLED", "SUSPENDED" -> handleSubscriptionCancel()
        else -> handleSubscriptionError()
      }
    }
  }

  private fun handleSubscriptionSuccess() {
    Log.i("PayPalSubscription", "Subscription successful.")
    setResult(Activity.RESULT_OK, Intent().apply {
      putExtra(EXTRA_RESULT_CONFIRMATION, "Subscription successful.")
    })
    Toast.makeText(this, "Subscription successful!", Toast.LENGTH_SHORT).show()
    finish()
  }

  private fun handleSubscriptionCancel() {
    Log.i("PayPalSubscription", "Subscription canceled.")
    Toast.makeText(this, "Subscription canceled.", Toast.LENGTH_SHORT).show()
    setResult(Activity.RESULT_CANCELED)
    finish()
  }

  private fun handleSubscriptionError() {
    Log.e("PayPalSubscription", "Subscription failed or unknown result.")
    Toast.makeText(this, "Failed to complete subscription.", Toast.LENGTH_SHORT).show()
    setResult(Activity.RESULT_CANCELED)
    finish()
  }
}
