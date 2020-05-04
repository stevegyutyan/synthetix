'use strict';

const { artifacts, contract, web3 } = require('@nomiclabs/buidler');
const { toBN } = web3.utils;

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');
const { currentTime, toUnit, fastForward } = require('../utils')();

const BinaryOption = artifacts.require('BinaryOption');
const SafeDecimalMath = artifacts.require('SafeDecimalMath');

contract('BinaryOption', accounts => {
    const [market, bidder, recipient] = accounts;

    const biddingTime = 100;
    const initialBid = toUnit(5);
    const initialPrice = toUnit(0.5);

    let option;
    let creationTime;

    const deployOption = async ({endOfBidding, initialBidder, initialBid, initialPrice, from}) => {
        return await BinaryOption.new(endOfBidding, initialBidder, initialBid, initialPrice, { from });
    };

    const setupNewOption = async () => {
        creationTime = await currentTime();
        option = await deployOption({
            endOfBidding: creationTime + biddingTime,
            initialBidder: bidder,
            initialBid,
            initialPrice,
            market,
        });
    };

    before(async () => {
        BinaryOption.link(await SafeDecimalMath.new());
        await setupNewOption();
    });

    addSnapshotBeforeRestoreAfterEach();

    describe('Basic parameters', () => {
        it('Bad constructor arguments revert', async () => {
            let localCreationTime = await currentTime();

            await assert.revert(deployOption({
                market,
                endOfBidding: localCreationTime - 10,
                initialBidder: bidder,
                initialBid,
                initialPrice,
                market,
            }), "Bidding period must end in the future.");


            localCreationTime = await currentTime();
            await assert.revert(deployOption({
                market,
                endOfBidding: localCreationTime + biddingTime,
                initialBidder: bidder,
                initialBid,
                initialPrice: toUnit(0),
                market,
            }), "Price out of range.");

            localCreationTime = await currentTime();
            await assert.revert(deployOption({
                market,
                endOfBidding: localCreationTime + biddingTime,
                initialBidder: bidder,
                initialBid,
                initialPrice: toUnit(1),
                market,
            }), "Price out of range.");
        });

        it('static parameters are set properly', async () => {
            assert.equal(await option.name(), "SNX Binary Option");
            assert.equal(await option.symbol(), "sOPT");
            assert.bnEqual(await option.decimals(), toBN(18));
            assert.equal(await option.market(), market)
            assert.bnEqual(await option.endOfBidding(), toBN(creationTime + biddingTime));
        });

        it('initial bid details are recorded properly', async () => {
            assert.bnEqual(await option.bids(bidder), initialBid);
            assert.bnEqual(await option.totalBids(), initialBid);
            assert.bnEqual(await option.price(), initialPrice);
        });
    });

    describe('Bidding', () => {
        it('biddingEnded properly understands when bidding has ended.', async () => {
            assert.isFalse(await option.biddingEnded());
            await fastForward(biddingTime * 2);
            assert.isTrue(await option.biddingEnded());
        });

        it('Cannot transfer tokens during bidding.', async () => {
            await assert.revert(option.transfer(recipient, toUnit(1), { from: bidder }),
            "Can only transfer after the end of bidding.")

            await option.approve(recipient, toUnit(10), { from: bidder });
            await assert.revert(option.transferFrom(bidder, recipient, toUnit(1), { from: recipient }),
            "Can only transfer after the end of bidding.");
        });

        it('Can transfer tokens after the end of bidding.', async () => {
            await fastForward(biddingTime * 2);
            option.transfer(recipient, toUnit(1), { from: bidder });

            await option.approve(recipient, toUnit(10), { from: bidder });
            await option.transferFrom(bidder, recipient, toUnit(1), { from: recipient });

        });

        it('Can place bids during bidding.', async () => {
            await option.updateBidAndPrice(bidder, toUnit(1), toUnit(0.25));
        });

        it('Cannot place bids after the end of the bidding phase.', async () => {
            await fastForward(biddingTime * 2);
            await assert.revert(option.updateBidAndPrice(bidder, toUnit(1), toUnit(0.25)),
            "Can't update the price or bids after the end of bidding.");
        });

        it('Bids properly update totals and price.', async () => {
            // Existing bidder bids.
            const newBid = toUnit(1);
            let newPrice = toUnit(0.25);
            const newSupply = initialBid.add(newBid);
            await option.updateBidAndPrice(bidder, newBid, newPrice, { from: market });
            assert.bnEqual(await option.bids(bidder), newSupply);
            assert.bnEqual(await option.totalBids(), newSupply);
            assert.bnEqual(await option.balanceOf(bidder), newSupply.mul(toBN(4)));
            assert.bnEqual(await option.totalSupply(), newSupply.mul(toBN(4)));
            assert.bnEqual(await option.price(), newPrice);

            // New bidder bids.
            newPrice = toUnit(0.75);
            await option.updateBidAndPrice(recipient, newBid, newPrice, { from: market });
            assert.bnEqual(await option.bids(recipient), newBid);
            assert.bnEqual(await option.totalBids(), newSupply.add(newBid));
            assert.bnEqual(await option.balanceOf(recipient), newBid.mul(toBN(4)).div(toBN(3)));
            assert.bnEqual(await option.totalSupply(), newSupply.add(newBid).mul(toBN(4)).div(toBN(3)));
            assert.bnEqual(await option.price(), newPrice);
        });

        it('Bids cannot be sent other than from the market.', async () => {
            const newBid = toUnit(1);
            let newPrice = toUnit(0.25);
            await assert.revert(option.updateBidAndPrice(bidder, newBid, newPrice, { from: bidder }),
            "Only the market can update bids and prices.");
        });

        it("Bid prices must be within the unit interval.", async () => {
            await assert.revert(option.updateBidAndPrice(bidder, toUnit(1), toUnit(0), { from: market }),
                "Price out of range");
            await assert.revert(option.updateBidAndPrice(bidder, toUnit(1), toUnit(1), { from: market }),
                "Price out of range");
        });

        it("Bids must be positive", async () => {
            await assert.revert(option.updateBidAndPrice(bidder, toBN(0), toUnit(0.25), { from: market }),
            "Bids must be positive.");
        });
    });

    describe.only('ERC20 functionality', () => {
        it('balanceOf', async () => {
            const bidderBalance = await option.balanceOf(bidder);
            assert.bnEqual(bidderBalance, toUnit(10));
        });

        it('transfer', async () => {
            // Transfer partial quantity.
            await fastForward(biddingTime * 2);
            let tx = await option.transfer(recipient, toUnit(2.5), { from: bidder });

            // Check that event is emitted properly.
            let log = tx.logs[0];
            assert.equal(log.event, "Transfer");
            assert.equal(log.args.from, bidder);
            assert.equal(log.args.to, recipient);
            assert.bnEqual(log.args.value, toUnit(2.5));

            // Check that balances have updated properly.
            assert.bnEqual(await option.balanceOf(bidder), toUnit(7.5));
            assert.bnEqual(await option.balanceOf(recipient), toUnit(2.5));

            // Transfer full balance.
            tx = await option.transfer(bidder, toUnit(2.5), { from: recipient });
            log = tx.logs[0];
            assert.equal(log.event, "Transfer");
            assert.equal(log.args.from, recipient);
            assert.equal(log.args.to, bidder);
            assert.bnEqual(log.args.value, toUnit(2.5));

            assert.bnEqual(await option.balanceOf(bidder), toUnit(10));
            assert.bnEqual(await option.balanceOf(recipient), toUnit(0));
        });

        it.only('Transfer when the price requires rounding', async () => {
            assert.isTrue(false);
        });

        it('approve & transferFrom', async () => {
            // Events, balances, allowances
            assert.isTrue(false);
        });

        it('totalSupply', async () => {
            assert.isTrue(false);
        });
    });
});