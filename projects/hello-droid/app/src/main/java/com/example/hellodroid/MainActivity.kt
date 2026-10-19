package com.example.hellodroid

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Hello Droid — a tiny app built the light way.
 *
 * No Gradle file, no XML layout, no appcompat: just one Kotlin Activity
 * compiled by code-droid's direct pipeline. Try changing the text or the
 * color, press "Build APK", and install it on your phone!
 */
class MainActivity : Activity() {

    private var taps = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val title = TextView(this).apply {
            text = "Hello from code-droid! 🤖"
            textSize = 24f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.rgb(0x0B, 0x57, 0x39))
            gravity = Gravity.CENTER
        }

        val counter = TextView(this).apply {
            text = "Button taps: 0"
            textSize = 16f
            gravity = Gravity.CENTER
        }

        val button = Button(this).apply {
            text = "Tap me"
            setOnClickListener {
                taps++
                counter.text = "Button taps: $taps"
            }
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            setBackgroundColor(Color.rgb(0xEA, 0xFC, 0xF2)) // android-green mist
            addView(title)
            addView(counter)
            addView(button, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = 32 })
        }

        setContentView(root)
    }
}
