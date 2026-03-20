
# Story1

It's time to get off work and the code is not finished yet. Let AI write for a while.
Suspend the AI ​​task and let him ask me questions through the conductor.

# Story2

At 3 o'clock in the afternoon, I went to the gym to exercise for an hour. At the same time, the AI ​​continued to write code without stopping. There was a problem.
Ask me for advice via mobile phone.

# Story3

I was walking the dog at night and suddenly came up with an idea on the road. I told it through conductor on my mobile phone.
AI, to realize such an idea, AI will be started immediately.

This example is more similar to the web-codex example, but web-codex has many restrictions. You must first have a repo.
And it's in the cloud, there is no local android test environment.

How to manage conductor sessions?

Whenever codex-do initiates a new task, if it is the first task, create the project first, and then create it in the project.
New task session.

There is a one-to-one correspondence between conductor tasks and codex sessions. Each conductor task created through mcp can be found
Corresponding codex session name
