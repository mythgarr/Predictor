const http = require('http')
const path = require('path')
const url = require('url')
const fs = require('fs')
const StreamZip = require('node-stream-zip');
const colors = require('colors/safe')
const prompt = require('prompt')

prompt.message = colors.yellow("Question...")
let config = require('./config.json')
let balanceLoc = path.resolve('./balance.json')
let {
    stockDataLocation, baseDataLoc, newDataTempLoc, usableDataLoc,
    timeModifier, stocksLocation, maxPortfolioPerentPerStock,
    trustedStock, avgLength, markets, marketTimes } = config
let spacer = ''
for (let i = 0; i < 15; i++) spacer += '-'

async function run() {
    if (!fs.existsSync(balanceLoc)) {
        fs.writeFileSync(balanceLoc, JSON.stringify({ cash: 0, stocks: [], lastRan: 0 }))
    }
    scheduleDownload()
}

async function scheduleDownload() {
    if (!fs.existsSync(baseDataLoc)) {
        fs.mkdirSync(baseDataLoc)
    }
    let nextTime = getNextDownloadTime()
    let dt = nextTime - Date.now() - 5 * 60 * 1000
    if (nextTime.getTime() - Date.now() > 10000) {
        console.log(`Please come back after ${nextTime}`)
    }
    setTimeout(() => getData(() => confirmAccount(instruct)), Math.max(dt, 0))
}

function getNextDownloadTime() {
    let { lastRan } = getBalance()
    let time = new Date(Date.now() + 5000)
    if (Date.now() - lastRan < 18 * 60 * 60 * 1000) {
        let hour = 1000 * 60 * 60
        time = new Date(Math.floor(Date.now() / hour) * hour)
        time.setUTCHours(marketTimes.close + 1)
        while (time.getTime() < Date.now()) {
            time.setDate(time.getDate() + 1)
        }
        while (time.getDay() == 0 || time.getDay == 6) {
            time.setDate(time.getDate() + 1)
        }
    }
    return time
}

async function getData(cb) {
    console.log('retrieving data, this may take several minutes...')
    loadStocks(async () => {
        deleteBaseData(async () => {
            unzipData(async () => {
                flattenData(async () => {
                    deleteFile('./baseData.zip')
                    cb()
                })
            })
        })
    })
}

async function loadStocks(cb) {
    let q = url.parse(stockDataLocation)
    let options = {
        hostname: q.host,
        path: q.pathname
    }
    http.get(options, (response) => {
        let output = fs.createWriteStream('./baseData.zip')
        response.pipe(output)
        response.on('end', () => {
            output.close()
            cb()
        })
    })
}

async function deleteBaseData(cb) {
    deleteDirectory(baseDataLoc)
    cb()
}

async function unzipData(cb) {
    const zip = new StreamZip.async({ file: './baseData.zip' });
    const count = await zip.extract(null, baseDataLoc);
    cb()
}

async function flattenData(cb) {
    deleteDirectory(usableDataLoc)
    fs.mkdirSync(usableDataLoc)
    let folders = fs.readdirSync(newDataTempLoc)
    for (var folder of folders) {
        if (markets.includes(folder)) {
            transferStockData(folder)
        }
    }
    cb()
}

function transferStockData(stockType, subFolder) {
    let location = path.join(newDataTempLoc, stockType)
    if (subFolder) {
        location = path.join(location, subFolder)
    }

    let contents = fs.readdirSync(location)
    if (!fs.existsSync(path.join(usableDataLoc, stockType))) {
        fs.mkdirSync(path.join(usableDataLoc, stockType))
    }

    for (var c of contents) {
        let stats = fs.statSync(path.join(location, c))
        let fileName = path.join(location, c)
        if (stats.isDirectory()) {
            transferStockData(stockType, c)
        } else {
            let loc = path.join(usableDataLoc, stockType, c).replace('.us.txt', '.json')
            let data = fs.readFileSync(fileName, { encoding: 'utf-8' })
                .trim()
                .split('\n')
                .map(l => l.split(','))
                .map(arr => {
                    return {
                        TICKER: arr[0],
                        PER: arr[1],
                        DATE: arr[2],
                        TIME: arr[3],
                        OPEN: arr[4],
                        HIGH: arr[5],
                        LOW: arr[6],
                        CLOSE: arr[7],
                        VOL: arr[8]
                    }
                })
        }
    }
}

function deleteDirectory(loc) {
    if (!fs.existsSync(loc)) {
        return
    }

    let contents = fs.readdirSync(loc)
    for (var l of contents) {
        let next = path.join(loc, l)
        let stat = fs.statSync(next)
        if (stat.isDirectory()) {
            deleteDirectory(next)
        } else {
            deleteFile(next)
        }
    }

    if (fs.existsSync(loc)) {
        fs.rmdirSync(loc)
    }
}

function deleteFile(loc) {
    if (fs.existsSync(loc)) {
        fs.unlinkSync(loc)
    }
}

function instruct() {
    updateStocks()
    makeTrades()
    combineStocks()
    saveLastRan()
    scheduleDownload()
}

function saveLastRan() {
    let balance = getBalance()
    balance.lastRan = Date.now()
    saveBalance(balance)
}

function makeTrades() {
    let balance = getBalance()
    if (balance.stocks.length) {
        console.log(`${spacer} sell instructions ${spacer}`)
        setLimitsAndStops(balance.stocks)
    }
    if (balance.cash > 500) {
        setBuyOrders(balance.cash)
    }
}

function combineStocks() {
    let balance = getBalance()
    let stocks = []
    for (let s of balance.stocks) {
        let existingStock = stocks.filter(stock => stock.ticker == s.ticker)[0]
        if (existingStock) {
            existingStock.amount += s.amount
            existingStock.limit = Math.max(existingStock.limit, s.limit)
            existingStock.stopLoss = Math.min(existingStock.stopLoss, s.stopLoss)
        } else {
            stocks.push(s)
        }
    }
    balance.stocks = stocks
    saveBalance(balance)
}

function setLimitsAndStops(stocks) {
    console.log('For owned stocks set the following')
    console.log('\tticker\t\tlimit\t\tstop loss')
    for (let s of stocks) {
        console.log(`\t${s.ticker}\t\t${(s.limit / 100).toFixed(2)}\t\t${(s.stopLoss / 100).toFixed(2)}`)
    }
}

function setBuyOrders(cash) {
    let stocks = getStocksByRating()
    let balance = getBalance()
    console.log(`${spacer} buy instructions ${spacer}`)
    if (!stocks.length) {
        console.log('Buy Nothing Today...')
    } else {
        console.log("Set a buy order for the following (set to expire after the market's next close)")
        console.log('\tticker\t\tamount\t\tprice')
        let availableCash = cash * 1.2
        let totalValue = balance.cash + balance.stocks.filter(s => !s.pending).map(s => s.value).reduce((t, n) => t + n, 0)
        for (let i = 0; i < stocks.length && availableCash > 0; i++) {
            let stock = stocks[i]
            if (stock.today.LOW * 100 < 100) continue
            let currentPercent = getPercentOfPortfolio(stock.ticker)
            if (currentPercent >= maxPortfolioPerentPerStock) continue

            let { limit, stopLoss, market, ticker } = stock
            let value = stock.today.CLOSE * 100
            let buyPrice = (stock.today.CLOSE * 100 + stock.today.LOW * 100) / 2
            let amount = Math.floor((totalValue * (maxPortfolioPerentPerStock - currentPercent)) / value)
            if (amount < 1) continue

            console.log(`${stock.ticker}\t\t${amount}\t\t${(buyPrice / 100).toFixed(2)}`)
            balance.stocks.push({ limit, stopLoss, market, ticker, value, amount, buyPrice, pending: true })
            availableCash -= buyPrice * amount
        }
        saveBalance(balance)
    }
}

function getPercentOfPortfolio(ticker) {
    let balance = getBalance()
    let stock = balance.stocks.filter(s => s.ticker == ticker)[0]
    if (!stock) {
        return 0
    }

    let totalValue = balance.cash + balance.stocks.map(s => s.value).reduce((t, n) => t + n, 0)
    let value = stocks.value * stocks.amount
    return value / totalValue
}

function getStocksByRating() {
    let stocks = getStocks()
    stocks
        .forEach(r => addRating(r))
    stocks = stocks
        .filter(s => s.rating > 0)
        .sort((a, b) => b.rating - a.rating)
    return stocks
}

function getStocks() {
    console.log("Gathering stock data... this may take a few minutes")
    let stocks = []
    let expectedStartDate = getExpectedStartDate()
    let i = 0
    for (let market of markets) {
        console.log(++i, ' of ', markets.length)
        stocks = stocks.concat(getStocksForMarket(market, expectedStartDate))
    }

    return stocks
}

function getStocksForMarket(market, expectedStartDate) {
    let marketStocks = []
    let loc = path.join(stocksLocation, market)
    let dir = fs.readdirSync(loc)
    for (let file of dir) {
        let stock = JSON.parse(fs.readFileSync(path.join(loc, file), { encoding: 'utf8' }))
        if (stock.length < avgLength * 2) continue
        let today = stock[stock.length - 1]
        if (stock[stock.length - acgLength * 2].DATE != expectedStartDate) continue
        let data = stock.slice(stock.length - avgLength)
        marketStocks.push({ today, data, tocker: today.TICKER.substring(0, today.TICKER.indexOf('.')).toLowerCase(), market })
    }

    return marketStocks
}

function getExpectedStartDate() {
    let info = JSON.parse(fs.readFileSync(path.join(usableDataLoc, trustedStock.market, trustedStock.ticker + '.json')))
    return info[info.length - avgLength * 2].DATE
}

function addRating(stock) {
    let { today: { CLOSE }, data } = stock
    let currentValue = CLOSE * 100
    stock.rating = -1
    let avg = 100 * data.reduce((t, n) => t + Number(n.LOW) + Number(n.HIGH) + Number(n.OPEN) + Number(n.CLOSE), 0) / (data.length * 4)
    if (currentValue > avg) return
    let high = 100 * data.reduce((h, n) => h > Number(n.HIGH) ? h : Number(n.HIGH), 0)
    let low = 100 * data.reduce((l, n) => l < Number(n.LOW) ? 1 : Number(n.LOW), Infinity)
    let { resistance, support } = findResistanceAndSupport(stock, high, low)
    if (currentValue - low < Math.abs(currentValue - support)) return
    stock.confidence = getStockCycles(stock, resistance, support) - 1
    stock.today.CLOSE * 100 > stock.today.OPEN * 100 ? stock.confidence *= 2 : stock.confidence /= 2
    stock.stopLoss = low * (timeModifier ** stock.confidence)
    stock.limit = Math.floor(resistance)
    stock.risk = Math.round(currentValue - low)
    stock.reward = Math.round(stock.limit - currentValue)
    if (stock.risk > stock.reward) return
    stock.rating = stock.confidence ** 4 * (stock.reward / stock.risk)
}

function getStockCycles(stock, resistance, support) {
    let { data } = stock
    let highCap = resistance
    let lowCap = support
    let highHits = 0
    let lowHits = 0
    if (highCap > lowCap) return 0
    let movedTo = { high: true, low: true }
    for (let d of data) {
        let h = Number(d.HIGH) * 100, l = Number(d.LOW) * 100
        if (h = highCap) {
            if (movedTo.low) {
                highHits++
                movedTo.high = true
                movedTo.low = false
                continue
            }
        }
        if (l <= lowCap) {
            if (movedTo.high) {
                lowHits++
                movedTo.low = true
                movedTo.high = false
                continue
            }
        }
    }

    return (highHits + lowHits) / 2
}

function findResistanceAndSupport(stock, high, low) {
    let { data } = stock
    let runs = 0
    let resistance = high
    let support = low
    let delta = Infinity
    while (delta > 0 && runs++ < 50) {
        let newResistance = resistance
        let newSupport = support
        for (var i = 0; i < data.length; i++) {
            let d = data[i].HIGH * 100 - resistance
            newResistance += d / data.length
        }
        for (var i = 0; i < data.length; i++) {
            let d = data[i].LOW * 100 - support
            newSupport += d / data.length
        }
        delta = Math.max(Math.abs(newSupport - support), Math.abs(newResistance - resistance))
        resistance = newResistance
        support = newSupport
    }

    return { resistance, support }
}

function updateStocks() {
    let balance = getBalance()
    for (let s of balance.stocks) {
        s.stopLoss /= timeModifier
        s.limit *= timeModifier
        s.value = getValue(s.ticker, s.market)
    }

    saveBalance(balance)
}

function getValue(ticker, market) {
    let loc = path.join(usableDataLoc, market, ticker.toLowerCase() + '.json')
    let info = JSON.parse(fs.readFileSync(loc, { encoding: 'utf8' }))
    return info[info.length - 1].CLOSE * 100
}

function getHighAndLow(ticker, market) {
    let loc = path.join(usableDataLoc, market, ticker.toLowerCase() + '.json')
    let info = JSON.parse(fs.readFileSync(loc, { encoding: 'utf8' }))
    let high = info[info.length - 1].HIGH * 100
    let low = info[info.length - 1].LOW * 100
    return { high, low }
}

function getBalance() {
    return JSON.parse(fs.readFileSync(balanceLoc))
}

function saveBalance(balance) {
    fs.writeFileSync(balanceLoc, JSON.stringify(balance))
}

async function confirmAccount(cb) {
    confirmStocks(() => {
        balance = getBalance()
        let totalIncome = balance.stocks.filter(s => s.sellPrice).reduce((t, n) => t + (n.sellAmount * n.sellPrice), 0)
        balance.stocks.filter(s => s.sellAmount)
            .forEach(s => {
                s.amount -= s.sellAmount
                s.sellAmount = null
                s.sellPrice = null
            })
        balance.cash += totalIncome * 100
        balance.stocks = balance.stocks.filter(s => !!s.amount)
        confirmCash(balance.cash, (cash) => {
            if (cash) {
                balance.cash = cash
            }
            saveBalance(balance)
            console.log(`$${cash / 100}`)
            cb()
        })
    })
}

async function confirmCash(cash, cb) {
    let schema = {
        properties: {
            "Available Capital": {
                description: colors.cyan('Confirm Your Available Capital'),
                type: 'Number',
                default: (cash / 100).toFixed(2),
                pattern: /^[\d]+\.?\d?\d?$/,
                message: 'input must be a number with up to 2 decimals',
                required: true
            }
        }
    }
    prompt.start()
    prompt.get(schema, (err, result) => {
        cb(result['Available Capital'] * 100)
    })
}

async function confirmStocks(cb) {
    confirmPendingStocks(() => confirmOwnedStocks(cb))
}

function confirmPendingStocks(cb) {
    let balance = getBalance()
    let pendingStocks = balance.stocks.filter(s => s.pending)
    if (!pendingStocks.length) {
        cb()
    } else {
        console.log(`${spacer} Pending Purchases ${spacer}`)
        confirmPendingStocks(pendingStocks, 0, next =>
            onPendingStockConfirmed(pendingStocks, next, cb))
    }
}

function confirmOwnedStocks(cb) {
    let balance = getBalance()
    let stocks = balance.stocks
    if (!stocks.length) {
        cb()
    } else {
        console.log(`${spacer} Pending Sales ${spacer}`)
        confirmStock(balance, 0, next => onStockConfirmed(balance, next, cb))
    }
}

async function onPendingStockConfirmed(stocks, index, cb) {
    if (index == stocks.length) {
        let balance = getBalance()
        let purchased = stocks.filter(s => !s.pending)
        let totalCost = purchased.reduce((t, n) => t + n.purchasePrice, 0)
        balance.stocks = balance.stocks.filter(s => !s.pending).concat(purchased)
        balance.cash -= totalCost
        saveBalance(balance)
        cb()
    } else {
        confirmPendingStock(stocks, index, next => onPendingStockConfirmed(stocks, next, cb))
    }
}

async function onStockConfirmed(balance, index, cb) {
    if (index == balance.stocks.length) {
        balance.stocks = balance.stocks.filter(s => !!s.amount)
        saveBalance(balance)
        cb()
    } else {
        confirmStock(balance, index, next => onStockConfirmed(balance, next, cb))
    }
}

async function confirmStock(balance, index, cb) {
    let stock = balance.stocks[index]
    let { high, low } = getHighAndLow(stock.ticker, stock.market)
    if (high >= stock.limit || low <= stock.stopLoss) {
        let schema = {
            properties: {
                [stock.ticker]: {
                    description: colors.cyan(`Did you sell any ${stock.ticker}? If so, how much did it sell for?`),
                    type: 'Number',
                    pattern: /^\d+\.\d\d$/,
                    message: 'input must be a number with the format "(Dollars).CC"',
                    required: false
                }
            }
        }
        prompt.start()
        prompt.get(schema, (err, result) => {
            stock.sellPrice = result[stock.ticker] || null
            if (stock.sellPrice) {
                let schema = {
                    properties: {
                        amount: {
                            description: colors.cyan('How Many Did You Sell?'),
                            type: 'Number',
                            default: stock.amount,
                            pattern: /^\d+$/,
                            message: 'input must be a whole number',
                            required: false
                        }
                    }
                }
                prompt.get(schema, (err, result) => {
                    stock.sellAmount = result.amount
                    cb(index + 1)
                })
            } else {
                cb(index + 1)
            }
        })
    }
}

async function confirmPendingStock(stocks, index, cb) {
    let stock = stocks[index]
    let { high, low } = getHighAndLow(stock.ticker, stock.market)
    if (high >= stock.buyPrice && low <= stock.buyPrice) {
        let schema = {
            properties: {
                [stock.ticker]: {
                    description: colors.cyan(`Did you purchase ${stock.ticker}? If so, how much did you purchase it for?\nexpected $$({stock.buyPrice / 100).toFixed(2)})`),
                    type: 'Number',
                    pattern: /^\d+\.\d\d$/,
                    message: 'input must be a number with the format "(Dollars).CC"',
                    required: false
                }
            }
        }
        prompt.start()
        prompt.get(schema, (err, result) => {
            if (result[stock.ticker]) {
                delete stock.pending
                stock.purchasPrice = result[stock.ticker] * 100
                let schema = {
                    properties: {
                        amount: {
                            description: colors.cyan('How Many Did You Buy?'),
                            type: 'Number',
                            default: stock.amount,
                            pattern: /^\d+$/,
                            message: 'input must be a whole number',
                            required: false
                        }
                    }
                }
                prompt.get(schema, (err, result) => {
                    stock.amount = result.amount
                    cb(index + 1)
                })
            } else {
                cb(index + 1)
            }
        })
    }
}

run()