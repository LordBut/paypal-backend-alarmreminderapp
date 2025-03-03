package com.alarmreminderapp.backend

import android.os.Bundle
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.alarmreminderapp.R

class SubscriptionResultActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_subscription_result)

        val resultStatus = intent.getStringExtra("RESULT_STATUS")
        val tierName = intent.getStringExtra("TIER_NAME")
        val errorMessage = intent.getStringExtra("ERROR_MESSAGE")

        val resultTextView: TextView = findViewById(R.id.resultTextView)

        if (resultStatus == "SUCCESS") {
            resultTextView.text = "You have successfully subscribed to the $tierName tier!"
        } else if (resultStatus == "FAILURE") {
            resultTextView.text = "Subscription failed: $errorMessage"
            Toast.makeText(this, errorMessage, Toast.LENGTH_SHORT).show()
        } else {
            resultTextView.text = "Unknown subscription status."
        }
    }
}
