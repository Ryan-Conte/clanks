# Privacy and permissions

## What stays on your computer

Everything, unless you choose otherwise. Your projects, chats, specs, designs, the board and the models are in clanks' data folder. There is no clanks account and no clanks server.

The app reaches the network only for what you asked for:

- downloading a model you pulled, from Hugging Face;
- a cloud model, if you gave a clank one, with your own key;
- a service you connected, at the addresses its integration lists;
- GitHub or GitLab, for a project that lives there;
- pages a clank reads or browses for a ticket;
- the marketplace's index, when you open the Marketplace page;
- the releases page, to see whether a newer clanks is out, unless you turn that off.

## Keys

API keys, tokens and passwords are kept by your operating system's keychain: Keychain on macOS, DPAPI on Windows, the secret service on Linux. They never go in the database or a plain file, never reach a model, and are taken out of logs. Without a keychain, clanks refuses to save a secret rather than keep it in plain text.

## What a clank can do

- **Files:** only inside its own copy of the project. It can't write anywhere else.
- **Commands:** everyday work, such as builds and tests, runs. Risky commands ask first, saying why: pushing, deleting outside its folder, global installs, deploying, sending data elsewhere. Settings → Approvals can make every command ask.
- **The browser:** in tabs of its own, apart from your browser. It can't type into password fields, upload files, or download without you.
- **Never:** push to your main branch, merge, send an email, post, or spend. Those happen only when you approve, and clanks itself does them, not a model.

What a clank reads on a web page, in a file or in another clank's work can't give it permissions. Approvals are decided only in the app.

## Updates

clanks checks its releases page when it starts and a few times a day. Finding a newer version only tells you: fetching it and restarting into it each wait for you. Turn the check off in Settings → This app, under Updates.

## Crash reports

When clanks crashes, a report of where in the app it happened is kept on your computer. It has no chats, files, prompts or keys in it. It's sent only if you turn that on in Settings → This app, under Crash reports, and only by a build that has somewhere to send it.
