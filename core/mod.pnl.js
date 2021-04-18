// PNL calculation module

const frostybot_module = require('./mod.base')
var context = require('express-http-context')
const axios = require('axios')

module.exports = class frostybot_pnl_module extends frostybot_module {


    // Load exchange for a given user uuid and stub

    async load_exchange(user, stub) {
        var accounts = await this.database.select('settings', {uuid: user, mainkey: 'accounts', subkey: stub});
        var encaccount = Array.isArray(accounts) && accounts.length == 1 && accounts[0].hasOwnProperty('value') ? JSON.parse(accounts[0].value) : {};
        var account = await this.utils.decrypt_values( this.utils.lower_props(encaccount), ['apikey', 'secret'])

        if (account) {
            if (account && account.hasOwnProperty (stub)) {
                account = account[stub];
            }
            const exchange_id = (account.hasOwnProperty('exchange') ? account.exchange : undefined);
            if (exchange_id == undefined) {
                return false;
            }
            this.exchange_id = exchange_id;
            var type = account.hasOwnProperty ('type') ? account.type : null;
            var ex_type = exchange_id + (type != null ? '.' + type : '');
            const exchange_class = require ('../exchanges/exchange.' + ex_type);
            var exchange = new exchange_class (stub, user);
            return exchange;
        }
        return false;
    }

    // Import orders for every user, stub and symbol

    async import_orders(params) {

        var schema = {
            user:        { optional: 'string', format: 'lowercase', },
            stub:        { optional: 'string' },
            market:      { optional: 'string', format: 'uppercase' },
            days:        { optional: 'number' },
        }        

        if (!(params = this.utils.validator(params, schema))) return false; 

        var [user, stub, market, days] = this.utils.extract_props(params, ['user', 'stub', 'market', 'days']);
        var url = await global.frostybot._modules_['core'].url();

        if (user == undefined) {

            // User is undefined

            var users = await this.database.select('users');

            if (Array.isArray(users)) {
                users.forEach(item => {
                    var uuid = context.get('uuid');
                    var user = item.uuid;

                    var payload = {
                        uuid        : uuid,
                        command     : 'pnl:import_orders',
                        user        : user,
                        days        : days
                    }

                    axios.post(url + '/frostybot',  payload);
                });
            }

            return true;
            
        } else {

            // User is defined

            if (stub == undefined) {

                // Stub is not defined

                var stubs = await this.database.select('settings', {uuid: user, mainkey: 'accounts'});

                if (Array.isArray(stubs)) {
                    stubs.forEach(item => {
                        var uuid = context.get('uuid');
                        var stub = item.subkey;
    
                        var payload = {
                            uuid        : uuid,
                            command     : 'pnl:import_orders',
                            user        : user,
                            stub        : stub,
                            days        : days
                        }
    
                        axios.post(url + '/frostybot',  payload);

                    })
                }

                return true;
    
            } else {


                // Stub is defined


                if (market == undefined) {

                    // Market is undefined

                    var exchange = await this.load_exchange(user, stub);
                
                    if (exchange != false) {

                        var symbols = exchange.orders_symbol_required ? await exchange.execute('symbols') : ['<ALL>'];

                        if (Array.isArray(symbols)) {
                            
                            symbols.forEach(async(symbol) => {

                                var uuid = context.get('uuid');    
                                var payload = {
                                    uuid        : uuid,
                                    command     : 'pnl:import_orders',
                                    user        : user,
                                    stub        : stub,
                                    market      : symbol,
                                    days        : days
                                }
    
                                axios.post(url + '/frostybot',  payload);

                                await this.utils.sleep(1);

                            })

                            return true;

                        }

                    }

                } else {


                    // Symbol is defined

                    if (String(market).toUpperCase() == '<ALL>') market = undefined;
                    var order_history = await this.order_history(user, stub, market, days);
                    var count = order_history.length;

                    if (Array.isArray(order_history)) {

                        order_history.forEach(async (order) => {

                            order.uuid = user
                            order.stub = stub
                            order.orderid = order.id
                            order.order_price = order.price
                            order.trigger_price = order.trigger
                        
                            delete order.id
                            delete order.price
                            delete order.trigger
                            delete order.datetime

                            var existing = await this.database.select('orders', {uuid: user, stub: stub, orderid: order.id});
                            if (Array.isArray(existing && existing.length == 1)) {                                
                                order = {...existing, ...order};
                            }
                        
                            if (!order.hasOwnProperty('size_usd')) order['size_usd'] = 0
                            if (!order.hasOwnProperty('size_usd')) order['size_usd'] = 0
                            if (!order.hasOwnProperty('filled_usd')) order['filled_usd'] = 0

                            var result = await this.database.insertOrReplace('orders', order);
                            if (result.changes > 0) {
                                console.log('UPDATED ORDER! ' + order.orderid)
                            }
                            console.log(order);

                        })

                    }

//                    console.log([user,stub,market,count].join(':'))

                    return true;
                }

            }

        }



        
    }

    // Get order history for a given user uuid, stub, symbol and days


    async order_history(user, stub, symbol, days = 7) {

        var ms = 1000 * 60 * 60 * 24 * days
         var ts = Date.now() - ms;

        console.log('Duration (ms):' + ms)
        console.log('Start timestamp: ' + ts);
        console.log('End timestamp: ' + Date.now());

        var all_orders = {};
        var order_params = { 
            stub: stub,
            since: ts
        }

        if (!['<ALL>',undefined].includes(symbol)) order_params['symbol'] = symbol;

        var exchange = await this.load_exchange(user, stub);
                
        if (exchange == false)
            return false;

        var orders =  await exchange.execute('order_history', order_params, true);

        while (orders.length > 0) {

            orders = orders.sort((a, b) => a.timestamp < b.timestamp ? -1 : 1)
            var batch_ts = {
                standard: 0,
                conditional: 0
            }

            for (var i = 0; i < orders.length; i++) {

                var order = orders[i];
                if (!all_orders.hasOwnProperty(order.id)) {
                    all_orders[order.id] = order;
                }

                if (['market','limit'].includes(order.type)) {
                    if (order.timestamp > batch_ts.standard) {
                        batch_ts.standard = order.timestamp;
                    } 
                } else {
                    if (order.timestamp > batch_ts.conditional) {
                        batch_ts.conditional = order.timestamp;
                    } 
                }

            }

            if (batch_ts.standard == 0) batch_ts.standard = batch_ts.conditional;
            if (batch_ts.conditional == 0) batch_ts.conditional = batch_ts.standard;

            var mints = Math.min(batch_ts.standard, batch_ts.conditional);
            if (mints == 0) break;

            order_params.since = mints + 1;
            orders =  await exchange.execute('order_history', order_params, true);
        }

        return Object.values(all_orders);

    }


}