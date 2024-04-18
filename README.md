# Installation
1. Download & install node.js version 10.15.0
2. Open a command prompt in the folder containing this README
3. run `npm install unzip@0.1.11`
4. run `npm install prompt@1.0.0`

# Instructions
Open a command prompt in the folder containing this README, then run `node run`.
Follow the on-screen prompts.

If something goes wrong, press Ctrl+C to exit.

# Configuration
The Close value may need to be increased in `config.json` as it is used to determine when to download the next stock data.
`stooq.com` has discontinued their REST API access of historical stock data - a replacement will need to be found.
A one-time manual download of historical data might be the best option, combined with a different website that provides
a REST API. eoddata.com might be a viable alternative.
