import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expect } from 'chai'
import { BigNumber, ContractFactory, Wallet } from 'ethers'
import hre, { ethers, waffle } from 'hardhat'
import { IMPLEMENTATION, ORACLE_ERROR, PRICE_TIMEOUT, REVENUE_HIDING } from '../../../fixtures'
import { defaultFixture, ORACLE_TIMEOUT } from '../fixtures'
import { getChainId } from '../../../../common/blockchain-utils'
import {
  IConfig,
  IGovParams,
  IRevenueShare,
  IRTokenConfig,
  IRTokenSetup,
  networkConfig,
} from '../../../../common/configuration'
import { CollateralStatus, MAX_UINT48, ZERO_ADDRESS } from '../../../../common/constants'
import { expectEvents, expectInIndirectReceipt } from '../../../../common/events'
import { bn, fp, toBNDecimals } from '../../../../common/numbers'
import { whileImpersonating } from '../../../utils/impersonation'
import {
  expectPrice,
  expectRTokenPrice,
  expectUnpriced,
  setOraclePrice,
} from '../../../utils/oracles'
import { advanceBlocks, advanceTime, getLatestBlockTimestamp } from '../../../utils/time'
import {
  Asset,
  ComptrollerMock,
  CTokenFiatCollateral,
  CTokenMock,
  ERC20Mock,
  FacadeRead,
  FacadeTest,
  FacadeWrite,
  IAssetRegistry,
  IBasketHandler,
  InvalidMockV3Aggregator,
  MockV3Aggregator,
  RTokenAsset,
  TestIBackingManager,
  TestIDeployer,
  TestIMain,
  TestIRToken,
} from '../../../../typechain'
import { useEnv } from '#/utils/env'

const createFixtureLoader = waffle.createFixtureLoader

// Holder address in Mainnet
const holderCDAI = '0x01ec5e7e03e2835bb2d1ae8d2edded298780129c'

const NO_PRICE_DATA_FEED = '0x51597f405303C4377E36123cBc172b13269EA163'

const describeFork = useEnv('FORK') ? describe : describe.skip

describeFork(`CTokenFiatCollateral - Mainnet Forking P${IMPLEMENTATION}`, function () {
  let owner: SignerWithAddress
  let addr1: SignerWithAddress

  // Tokens/Assets
  let dai: ERC20Mock
  let cDai: CTokenMock
  let cDaiCollateral: CTokenFiatCollateral
  let compToken: ERC20Mock
  let compAsset: Asset
  let comptroller: ComptrollerMock
  let rsr: ERC20Mock
  let rsrAsset: Asset

  // Core Contracts
  let main: TestIMain
  let rToken: TestIRToken
  let rTokenAsset: RTokenAsset
  let assetRegistry: IAssetRegistry
  let backingManager: TestIBackingManager
  let basketHandler: IBasketHandler

  let deployer: TestIDeployer
  let facade: FacadeRead
  let facadeTest: FacadeTest
  let facadeWrite: FacadeWrite
  let govParams: IGovParams

  // RToken Configuration
  const dist: IRevenueShare = {
    rTokenDist: bn(40), // 2/5 RToken
    rsrDist: bn(60), // 3/5 RSR
  }
  const config: IConfig = {
    dist: dist,
    minTradeVolume: fp('1e4'), // $10k
    rTokenMaxTradeVolume: fp('1e6'), // $1M
    shortFreeze: bn('259200'), // 3 days
    longFreeze: bn('2592000'), // 30 days
    rewardRatio: bn('1069671574938'), // approx. half life of 90 days
    unstakingDelay: bn('1209600'), // 2 weeks
    tradingDelay: bn('0'), // (the delay _after_ default has been confirmed)
    auctionLength: bn('900'), // 15 minutes
    backingBuffer: fp('0.0001'), // 0.01%
    maxTradeSlippage: fp('0.01'), // 1%
    issuanceThrottle: {
      amtRate: fp('1e6'), // 1M RToken
      pctRate: fp('0.05'), // 5%
    },
    redemptionThrottle: {
      amtRate: fp('1e6'), // 1M RToken
      pctRate: fp('0.05'), // 5%
    },
  }

  const defaultThreshold = fp('0.01') // 1%
  const delayUntilDefault = bn('86400') // 24h

  let initialBal: BigNumber

  let loadFixture: ReturnType<typeof createFixtureLoader>
  let wallet: Wallet

  let chainId: number

  let CTokenCollateralFactory: ContractFactory
  let MockV3AggregatorFactory: ContractFactory
  let mockChainlinkFeed: MockV3Aggregator

  before(async () => {
    ;[wallet] = (await ethers.getSigners()) as unknown as Wallet[]
    loadFixture = createFixtureLoader([wallet])

    chainId = await getChainId(hre)
    if (!networkConfig[chainId]) {
      throw new Error(`Missing network configuration for ${hre.network.name}`)
    }
  })

  beforeEach(async () => {
    ;[owner, addr1] = await ethers.getSigners()
    ;({ rsr, rsrAsset, deployer, facade, facadeTest, facadeWrite, govParams } = await loadFixture(
      defaultFixture
    ))

    // Get required contracts for cDAI
    // COMP token
    compToken = <ERC20Mock>(
      await ethers.getContractAt('ERC20Mock', networkConfig[chainId].tokens.COMP || '')
    )
    // Compound Comptroller
    comptroller = await ethers.getContractAt(
      'ComptrollerMock',
      networkConfig[chainId].COMPTROLLER || ''
    )
    // DAI token
    dai = <ERC20Mock>(
      await ethers.getContractAt('ERC20Mock', networkConfig[chainId].tokens.DAI || '')
    )
    // cDAI token
    cDai = <CTokenMock>(
      await ethers.getContractAt('CTokenMock', networkConfig[chainId].tokens.cDAI || '')
    )

    // Create COMP asset
    compAsset = <Asset>(
      await (
        await ethers.getContractFactory('Asset')
      ).deploy(
        PRICE_TIMEOUT,
        networkConfig[chainId].chainlinkFeeds.COMP || '',
        ORACLE_ERROR,
        compToken.address,
        config.rTokenMaxTradeVolume,
        ORACLE_TIMEOUT
      )
    )

    // Deploy cDai collateral plugin
    CTokenCollateralFactory = await ethers.getContractFactory('CTokenFiatCollateral')
    cDaiCollateral = <CTokenFiatCollateral>await CTokenCollateralFactory.deploy(
      {
        priceTimeout: PRICE_TIMEOUT,
        chainlinkFeed: networkConfig[chainId].chainlinkFeeds.DAI as string,
        oracleError: ORACLE_ERROR,
        erc20: cDai.address,
        maxTradeVolume: config.rTokenMaxTradeVolume,
        oracleTimeout: ORACLE_TIMEOUT,
        targetName: ethers.utils.formatBytes32String('USD'),
        defaultThreshold,
        delayUntilDefault,
      },
      REVENUE_HIDING,
      comptroller.address
    )

    // Setup balances for addr1 - Transfer from Mainnet holder
    // cDAI
    initialBal = bn('2000000e18')
    await whileImpersonating(holderCDAI, async (cdaiSigner) => {
      await cDai.connect(cdaiSigner).transfer(addr1.address, toBNDecimals(initialBal, 8))
    })

    // Set parameters
    const rTokenConfig: IRTokenConfig = {
      name: 'RTKN RToken',
      symbol: 'RTKN',
      mandate: 'mandate',
      params: config,
    }

    // Set primary basket
    const rTokenSetup: IRTokenSetup = {
      assets: [compAsset.address],
      primaryBasket: [cDaiCollateral.address],
      weights: [fp('1')],
      backups: [],
      beneficiaries: [],
    }

    // Deploy RToken via FacadeWrite
    const receipt = await (
      await facadeWrite.connect(owner).deployRToken(rTokenConfig, rTokenSetup)
    ).wait()

    // Get Main
    const mainAddr = expectInIndirectReceipt(receipt, deployer.interface, 'RTokenCreated').args.main
    main = <TestIMain>await ethers.getContractAt('TestIMain', mainAddr)

    // Get core contracts
    assetRegistry = <IAssetRegistry>(
      await ethers.getContractAt('IAssetRegistry', await main.assetRegistry())
    )
    backingManager = <TestIBackingManager>(
      await ethers.getContractAt('TestIBackingManager', await main.backingManager())
    )
    basketHandler = <IBasketHandler>(
      await ethers.getContractAt('IBasketHandler', await main.basketHandler())
    )
    rToken = <TestIRToken>await ethers.getContractAt('TestIRToken', await main.rToken())
    rTokenAsset = <RTokenAsset>(
      await ethers.getContractAt('RTokenAsset', await assetRegistry.toAsset(rToken.address))
    )

    // Setup owner and unpause
    await facadeWrite.connect(owner).setupGovernance(
      rToken.address,
      false, // do not deploy governance
      true, // unpaused
      govParams, // mock values, not relevant
      owner.address, // owner
      ZERO_ADDRESS, // no guardian
      ZERO_ADDRESS // no pauser
    )

    // Setup mock chainlink feed for some of the tests (so we can change the value)
    MockV3AggregatorFactory = await ethers.getContractFactory('MockV3Aggregator')
    mockChainlinkFeed = <MockV3Aggregator>await MockV3AggregatorFactory.deploy(8, bn('1e8'))
  })

  describe('Deployment', () => {
    // Check the initial state
    it('Should setup RToken, Assets, and Collateral correctly', async () => {
      // Check Rewards assets (if applies)
      // COMP Asset
      expect(await compAsset.isCollateral()).to.equal(false)
      expect(await compAsset.erc20()).to.equal(compToken.address)
      expect(await compAsset.erc20()).to.equal(networkConfig[chainId].tokens.COMP)
      expect(await compToken.decimals()).to.equal(18)
      await expectPrice(compAsset.address, fp('58.28'), ORACLE_ERROR, true) // Close to $58 USD - June 2022
      await expect(compAsset.claimRewards()).to.not.emit(compAsset, 'RewardsClaimed')
      expect(await compAsset.maxTradeVolume()).to.equal(config.rTokenMaxTradeVolume)

      // Check Collateral plugin
      // cDAI (CTokenFiatCollateral)
      expect(await cDaiCollateral.isCollateral()).to.equal(true)
      expect(await cDaiCollateral.referenceERC20Decimals()).to.equal(await dai.decimals())
      expect(await cDaiCollateral.erc20()).to.equal(cDai.address)
      expect(await cDai.decimals()).to.equal(8)
      expect(await cDaiCollateral.targetName()).to.equal(ethers.utils.formatBytes32String('USD'))
      expect(await cDaiCollateral.refPerTok()).to.be.closeTo(fp('0.022'), fp('0.001'))
      expect(await cDaiCollateral.targetPerRef()).to.equal(fp('1'))
      expect(await cDaiCollateral.exposedReferencePrice()).to.equal(
        await cDaiCollateral.refPerTok()
      )
      await expectPrice(
        cDaiCollateral.address,
        fp('0.022015105509346448'),
        ORACLE_ERROR,
        true,
        bn('1e5')
      ) // close to $0.022 cents

      // Check claim data
      await expect(cDaiCollateral.claimRewards())
        .to.emit(cDaiCollateral, 'RewardsClaimed')
        .withArgs(compToken.address, 0)
      expect(await cDaiCollateral.maxTradeVolume()).to.equal(config.rTokenMaxTradeVolume)

      // Should setup contracts
      expect(main.address).to.not.equal(ZERO_ADDRESS)
    })

    // Check assets/collaterals in the Asset Registry
    it('Should register ERC20s and Assets/Collateral correctly', async () => {
      // Check assets/collateral
      const ERC20s = await assetRegistry.erc20s()
      expect(ERC20s[0]).to.equal(rToken.address)
      expect(ERC20s[1]).to.equal(rsr.address)
      expect(ERC20s[2]).to.equal(compToken.address)
      expect(ERC20s[3]).to.equal(cDai.address)
      expect(ERC20s.length).to.eql(4)

      // Assets
      expect(await assetRegistry.toAsset(ERC20s[0])).to.equal(rTokenAsset.address)
      expect(await assetRegistry.toAsset(ERC20s[1])).to.equal(rsrAsset.address)
      expect(await assetRegistry.toAsset(ERC20s[2])).to.equal(compAsset.address)
      expect(await assetRegistry.toAsset(ERC20s[3])).to.equal(cDaiCollateral.address)

      // Collaterals
      expect(await assetRegistry.toColl(ERC20s[3])).to.equal(cDaiCollateral.address)
    })

    // Check RToken basket
    it('Should register Basket correctly', async () => {
      // Basket
      expect(await basketHandler.fullyCollateralized()).to.equal(true)
      const backing = await facade.basketTokens(rToken.address)
      expect(backing[0]).to.equal(cDai.address)
      expect(backing.length).to.equal(1)

      // Check other values
      expect(await basketHandler.timestamp()).to.be.gt(bn(0))
      expect(await basketHandler.status()).to.equal(CollateralStatus.SOUND)
      expect(await facadeTest.callStatic.totalAssetValue(rToken.address)).to.equal(0)
      await expectPrice(basketHandler.address, fp('1'), ORACLE_ERROR, true)

      // Check RToken price
      const issueAmount: BigNumber = bn('10000e18')
      await cDai.connect(addr1).approve(rToken.address, toBNDecimals(issueAmount, 8).mul(100))
      await advanceTime(3600)
      await expect(rToken.connect(addr1).issue(issueAmount)).to.emit(rToken, 'Issuance')
      await expectRTokenPrice(
        rTokenAsset.address,
        fp('1'),
        ORACLE_ERROR,
        await backingManager.maxTradeSlippage(),
        config.minTradeVolume.mul((await assetRegistry.erc20s()).length)
      )
    })

    // Validate constructor arguments
    // Note: Adapt it to your plugin constructor validations
    it('Should validate constructor arguments correctly', async () => {
      // Comptroller
      await expect(
        CTokenCollateralFactory.deploy(
          {
            priceTimeout: PRICE_TIMEOUT,
            chainlinkFeed: networkConfig[chainId].chainlinkFeeds.DAI as string,
            oracleError: ORACLE_ERROR,
            erc20: cDai.address,
            maxTradeVolume: config.rTokenMaxTradeVolume,
            oracleTimeout: ORACLE_TIMEOUT,
            targetName: ethers.utils.formatBytes32String('USD'),
            defaultThreshold,
            delayUntilDefault,
          },
          REVENUE_HIDING,
          ZERO_ADDRESS
        )
      ).to.be.revertedWith('comptroller missing')
    })
  })

  describe('Issuance/Appreciation/Redemption', () => {
    const MIN_ISSUANCE_PER_BLOCK = bn('10000e18')

    // Issuance and redemption, making the collateral appreciate over time
    it('Should issue, redeem, and handle appreciation rates correctly', async () => {
      const issueAmount: BigNumber = MIN_ISSUANCE_PER_BLOCK // instant issuance

      // Provide approvals for issuances
      await cDai.connect(addr1).approve(rToken.address, toBNDecimals(issueAmount, 8).mul(100))

      await advanceTime(3600)

      // Issue rTokens
      await expect(rToken.connect(addr1).issue(issueAmount)).to.emit(rToken, 'Issuance')

      // Check RTokens issued to user
      expect(await rToken.balanceOf(addr1.address)).to.equal(issueAmount)

      // Store Balances after issuance
      const balanceAddr1cDai: BigNumber = await cDai.balanceOf(addr1.address)

      // Check rates and prices
      const [cDaiPriceLow1, cDaiPriceHigh1] = await cDaiCollateral.price() // ~ 0.022015 cents
      const cDaiRefPerTok1: BigNumber = await cDaiCollateral.refPerTok() // ~ 0.022015 cents

      await expectPrice(
        cDaiCollateral.address,
        fp('0.022015105946267361'),
        ORACLE_ERROR,
        true,
        bn('1e5')
      )
      expect(cDaiRefPerTok1).to.be.closeTo(fp('0.022'), fp('0.001'))

      // Check total asset value
      const totalAssetValue1: BigNumber = await facadeTest.callStatic.totalAssetValue(
        rToken.address
      )
      expect(totalAssetValue1).to.be.closeTo(issueAmount, fp('150')) // approx 10K in value

      // Advance time and blocks slightly, causing refPerTok() to increase
      await advanceTime(10000)
      await advanceBlocks(10000)

      // Refresh cToken manually (required)
      await cDaiCollateral.refresh()
      expect(await cDaiCollateral.status()).to.equal(CollateralStatus.SOUND)

      // Check rates and prices - Have changed, slight inrease
      const [cDaiPriceLow2, cDaiPriceHigh2] = await cDaiCollateral.price() // ~0.022016
      const cDaiRefPerTok2: BigNumber = await cDaiCollateral.refPerTok() // ~0.022016

      // Check rates and price increase
      expect(cDaiPriceLow2).to.be.gt(cDaiPriceLow1)
      expect(cDaiPriceHigh2).to.be.gt(cDaiPriceHigh1)
      expect(cDaiRefPerTok2).to.be.gt(cDaiRefPerTok1)

      // Still close to the original values
      await expectPrice(
        cDaiCollateral.address,
        fp('0.022016198467092545'),
        ORACLE_ERROR,
        true,
        bn('1e5')
      )
      expect(cDaiRefPerTok2).to.be.closeTo(fp('0.022'), fp('0.001'))

      // Check total asset value increased
      const totalAssetValue2: BigNumber = await facadeTest.callStatic.totalAssetValue(
        rToken.address
      )
      expect(totalAssetValue2).to.be.gt(totalAssetValue1)

      // Advance time and blocks slightly, causing refPerTok() to increase
      await advanceTime(100000000)
      await advanceBlocks(100000000)

      // Refresh cToken manually (required)
      await cDaiCollateral.refresh()
      expect(await cDaiCollateral.status()).to.equal(CollateralStatus.SOUND)

      // Check rates and prices - Have changed significantly
      const [cDaiPriceLow3, cDaiPriceHigh3] = await cDaiCollateral.price() // ~0.03294
      const cDaiRefPerTok3: BigNumber = await cDaiCollateral.refPerTok() // ~0.03294

      // Check rates and price increase
      expect(cDaiPriceLow3).to.be.gt(cDaiPriceLow2)
      expect(cDaiPriceHigh3).to.be.gt(cDaiPriceHigh2)
      expect(cDaiRefPerTok3).to.be.gt(cDaiRefPerTok2)

      await expectPrice(
        cDaiCollateral.address,
        fp('0.032941254792840879'),
        ORACLE_ERROR,
        true,
        bn('1e5')
      )
      expect(cDaiRefPerTok3).to.be.closeTo(fp('0.032'), fp('0.001'))

      // Check total asset value increased
      const totalAssetValue3: BigNumber = await facadeTest.callStatic.totalAssetValue(
        rToken.address
      )
      expect(totalAssetValue3).to.be.gt(totalAssetValue2)

      // Redeem Rtokens with the updated rates
      await expect(rToken.connect(addr1).redeem(issueAmount, await basketHandler.nonce())).to.emit(
        rToken,
        'Redemption'
      )

      // Check funds were transferred
      expect(await rToken.balanceOf(addr1.address)).to.equal(0)
      expect(await rToken.totalSupply()).to.equal(0)

      // Check balances - Fewer cTokens should have been sent to the user
      const newBalanceAddr1cDai: BigNumber = await cDai.balanceOf(addr1.address)

      // Check received tokens represent ~10K in value at current prices
      expect(newBalanceAddr1cDai.sub(balanceAddr1cDai)).to.be.closeTo(bn('303570e8'), bn('8e7')) // ~0.03294 * 303571 ~= 10K (100% of basket)

      // Check remainders in Backing Manager
      expect(await cDai.balanceOf(backingManager.address)).to.be.closeTo(bn(150663e8), bn('5e7')) // ~= 4962.8 usd in value

      //  Check total asset value (remainder)
      expect(await facadeTest.callStatic.totalAssetValue(rToken.address)).to.be.closeTo(
        fp('4962.8'), // ~= 4962.8 usd (from above)
        fp('0.5')
      )
    })
  })

  // Note: Even if the collateral does not provide reward tokens, this test should be performed to check that
  // claiming calls throughout the protocol are handled correctly and do not revert.
  describe('Rewards', () => {
    it('Should be able to claim rewards (if applicable)', async () => {
      const MIN_ISSUANCE_PER_BLOCK = bn('10000e18')
      const issueAmount: BigNumber = MIN_ISSUANCE_PER_BLOCK

      // Try to claim rewards at this point - Nothing for Backing Manager
      expect(await compToken.balanceOf(backingManager.address)).to.equal(0)

      await expectEvents(backingManager.claimRewards(), [
        {
          contract: backingManager,
          name: 'RewardsClaimed',
          args: [compToken.address, bn(0)],
          emitted: true,
        },
      ])

      // No rewards so far
      expect(await compToken.balanceOf(backingManager.address)).to.equal(0)

      // Provide approvals for issuances
      await cDai.connect(addr1).approve(rToken.address, toBNDecimals(issueAmount, 8).mul(100))

      await advanceTime(3600)

      // Issue rTokens
      await expect(rToken.connect(addr1).issue(issueAmount)).to.emit(rToken, 'Issuance')

      // Check RTokens issued to user
      expect(await rToken.balanceOf(addr1.address)).to.equal(issueAmount)

      // Now we can claim rewards - check initial balance still 0
      expect(await compToken.balanceOf(backingManager.address)).to.equal(0)

      // Advance Time
      await advanceTime(8000)

      // Claim rewards
      await expect(backingManager.claimRewards()).to.emit(backingManager, 'RewardsClaimed')

      // Check rewards both in COMP and stkAAVE
      const rewardsCOMP1: BigNumber = await compToken.balanceOf(backingManager.address)

      expect(rewardsCOMP1).to.be.gt(0)

      // Keep moving time
      await advanceTime(3600)

      // Get additional rewards
      await expect(backingManager.claimRewards()).to.emit(backingManager, 'RewardsClaimed')

      const rewardsCOMP2: BigNumber = await compToken.balanceOf(backingManager.address)

      expect(rewardsCOMP2.sub(rewardsCOMP1)).to.be.gt(0)
    })
  })

  describe('Price Handling', () => {
    it('Should handle invalid/stale Price', async () => {
      // Does not revert with stale price
      await advanceTime(ORACLE_TIMEOUT.toString())

      // Compound
      await expectUnpriced(cDaiCollateral.address)

      // Refresh should mark status IFFY
      await cDaiCollateral.refresh()
      expect(await cDaiCollateral.status()).to.equal(CollateralStatus.IFFY)

      // CTokens Collateral with no price
      const nonpriceCtokenCollateral: CTokenFiatCollateral = <CTokenFiatCollateral>await (
        await ethers.getContractFactory('CTokenFiatCollateral')
      ).deploy(
        {
          priceTimeout: PRICE_TIMEOUT,
          chainlinkFeed: NO_PRICE_DATA_FEED,
          oracleError: ORACLE_ERROR,
          erc20: cDai.address,
          maxTradeVolume: config.rTokenMaxTradeVolume,
          oracleTimeout: ORACLE_TIMEOUT,
          targetName: ethers.utils.formatBytes32String('USD'),
          defaultThreshold,
          delayUntilDefault,
        },
        REVENUE_HIDING,
        comptroller.address
      )

      // CTokens - Collateral with no price info should revert
      await expect(nonpriceCtokenCollateral.price()).to.be.revertedWith('')

      // Refresh should also revert - status is not modified
      await expect(nonpriceCtokenCollateral.refresh()).to.be.reverted
      expect(await nonpriceCtokenCollateral.status()).to.equal(CollateralStatus.SOUND)

      // Does not revert with zero price
      const zeropriceCtokenCollateral: CTokenFiatCollateral = <CTokenFiatCollateral>await (
        await ethers.getContractFactory('CTokenFiatCollateral')
      ).deploy(
        {
          priceTimeout: PRICE_TIMEOUT,
          chainlinkFeed: mockChainlinkFeed.address,
          oracleError: ORACLE_ERROR,
          erc20: cDai.address,
          maxTradeVolume: config.rTokenMaxTradeVolume,
          oracleTimeout: ORACLE_TIMEOUT,
          targetName: ethers.utils.formatBytes32String('USD'),
          defaultThreshold,
          delayUntilDefault,
        },
        REVENUE_HIDING,
        comptroller.address
      )

      await setOraclePrice(zeropriceCtokenCollateral.address, bn(0))

      // Does not revert with zero price
      await expectPrice(zeropriceCtokenCollateral.address, bn('0'), bn('0'), false)

      // Refresh should mark status IFFY
      await zeropriceCtokenCollateral.refresh()
      expect(await zeropriceCtokenCollateral.status()).to.equal(CollateralStatus.IFFY)
    })
  })

  // Note: Here the idea is to test all possible statuses and check all possible paths to default
  // soft default = SOUND -> IFFY -> DISABLED due to sustained misbehavior
  // hard default = SOUND -> DISABLED due to an invariant violation
  // This may require to deploy some mocks to be able to force some of these situations
  describe('Collateral Status', () => {
    // Test for soft default
    it('Updates status in case of soft default', async () => {
      // Redeploy plugin using a Chainlink mock feed where we can change the price
      const newCDaiCollateral: CTokenFiatCollateral = <CTokenFiatCollateral>await (
        await ethers.getContractFactory('CTokenFiatCollateral')
      ).deploy(
        {
          priceTimeout: PRICE_TIMEOUT,
          chainlinkFeed: mockChainlinkFeed.address,
          oracleError: ORACLE_ERROR,
          erc20: await cDaiCollateral.erc20(),
          maxTradeVolume: await cDaiCollateral.maxTradeVolume(),
          oracleTimeout: await cDaiCollateral.oracleTimeout(),
          targetName: await cDaiCollateral.targetName(),
          defaultThreshold,
          delayUntilDefault: await cDaiCollateral.delayUntilDefault(),
        },
        REVENUE_HIDING,
        comptroller.address
      )

      // Check initial state
      expect(await newCDaiCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await newCDaiCollateral.whenDefault()).to.equal(MAX_UINT48)

      // Depeg one of the underlying tokens - Reducing price 20%
      await setOraclePrice(newCDaiCollateral.address, bn('8e7')) // -20%

      // Force updates - Should update whenDefault and status
      await expect(newCDaiCollateral.refresh())
        .to.emit(newCDaiCollateral, 'CollateralStatusChanged')
        .withArgs(CollateralStatus.SOUND, CollateralStatus.IFFY)
      expect(await newCDaiCollateral.status()).to.equal(CollateralStatus.IFFY)

      const expectedDefaultTimestamp: BigNumber = bn(await getLatestBlockTimestamp()).add(
        delayUntilDefault
      )
      expect(await newCDaiCollateral.whenDefault()).to.equal(expectedDefaultTimestamp)

      // Move time forward past delayUntilDefault
      await advanceTime(Number(delayUntilDefault))
      expect(await newCDaiCollateral.status()).to.equal(CollateralStatus.DISABLED)

      // Nothing changes if attempt to refresh after default
      // CToken
      const prevWhenDefault: BigNumber = await newCDaiCollateral.whenDefault()
      await expect(newCDaiCollateral.refresh()).to.not.emit(
        newCDaiCollateral,
        'CollateralStatusChanged'
      )
      expect(await newCDaiCollateral.status()).to.equal(CollateralStatus.DISABLED)
      expect(await newCDaiCollateral.whenDefault()).to.equal(prevWhenDefault)
    })

    // Test for hard default
    it('Updates status in case of hard default', async () => {
      // Note: In this case requires to use a CToken mock to be able to change the rate
      const CTokenMockFactory: ContractFactory = await ethers.getContractFactory('CTokenMock')
      const symbol = await cDai.symbol()
      const cDaiMock: CTokenMock = <CTokenMock>(
        await CTokenMockFactory.deploy(symbol + ' Token', symbol, dai.address)
      )
      // Set initial exchange rate to the new cDai Mock
      await cDaiMock.setExchangeRate(fp('0.02'))

      // Redeploy plugin using the new cDai mock
      const newCDaiCollateral: CTokenFiatCollateral = <CTokenFiatCollateral>await (
        await ethers.getContractFactory('CTokenFiatCollateral')
      ).deploy(
        {
          priceTimeout: PRICE_TIMEOUT,
          chainlinkFeed: await cDaiCollateral.chainlinkFeed(),
          oracleError: ORACLE_ERROR,
          erc20: cDaiMock.address,
          maxTradeVolume: await cDaiCollateral.maxTradeVolume(),
          oracleTimeout: await cDaiCollateral.oracleTimeout(),
          targetName: await cDaiCollateral.targetName(),
          defaultThreshold,
          delayUntilDefault: await cDaiCollateral.delayUntilDefault(),
        },
        REVENUE_HIDING,
        comptroller.address
      )
      await newCDaiCollateral.refresh()

      // Check initial state
      expect(await newCDaiCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await newCDaiCollateral.whenDefault()).to.equal(MAX_UINT48)

      // Decrease rate for cDAI, will disable collateral immediately
      await cDaiMock.setExchangeRate(fp('0.019'))

      // Force updates - Should update whenDefault and status for Atokens/CTokens
      await expect(newCDaiCollateral.refresh())
        .to.emit(newCDaiCollateral, 'CollateralStatusChanged')
        .withArgs(CollateralStatus.SOUND, CollateralStatus.DISABLED)

      expect(await newCDaiCollateral.status()).to.equal(CollateralStatus.DISABLED)
      const expectedDefaultTimestamp: BigNumber = bn(await getLatestBlockTimestamp())
      expect(await newCDaiCollateral.whenDefault()).to.equal(expectedDefaultTimestamp)
    })

    it('Reverts if oracle reverts or runs out of gas, maintains status', async () => {
      const InvalidMockV3AggregatorFactory = await ethers.getContractFactory(
        'InvalidMockV3Aggregator'
      )
      const invalidChainlinkFeed: InvalidMockV3Aggregator = <InvalidMockV3Aggregator>(
        await InvalidMockV3AggregatorFactory.deploy(8, bn('1e8'))
      )

      const invalidCTokenCollateral: CTokenFiatCollateral = <CTokenFiatCollateral>(
        await CTokenCollateralFactory.deploy(
          {
            priceTimeout: PRICE_TIMEOUT,
            chainlinkFeed: invalidChainlinkFeed.address,
            oracleError: ORACLE_ERROR,
            erc20: await cDaiCollateral.erc20(),
            maxTradeVolume: await cDaiCollateral.maxTradeVolume(),
            oracleTimeout: await cDaiCollateral.oracleTimeout(),
            targetName: await cDaiCollateral.targetName(),
            defaultThreshold,
            delayUntilDefault: await cDaiCollateral.delayUntilDefault(),
          },
          REVENUE_HIDING,
          comptroller.address
        )
      )

      // Reverting with no reason
      await invalidChainlinkFeed.setSimplyRevert(true)
      await expect(invalidCTokenCollateral.refresh()).to.be.revertedWith('')
      expect(await invalidCTokenCollateral.status()).to.equal(CollateralStatus.SOUND)

      // Runnning out of gas (same error)
      await invalidChainlinkFeed.setSimplyRevert(false)
      await expect(invalidCTokenCollateral.refresh()).to.be.revertedWith('')
      expect(await invalidCTokenCollateral.status()).to.equal(CollateralStatus.SOUND)
    })
  })
})
