const { Logger } = require('../../utils/logger');

class YouTubeOrchestrator {
  constructor({ db, agents, services = {}, notify = null } = {}) {
    this.db = db;
    this.agents = agents || {};
    this.services = services;
    this.notify = notify || (async () => null);
    this.logger = new Logger('YouTubeOrchestrator');
  }

  getStatus() {
    return {
      name: 'YouTubeOrchestrator',
      version: '1.0.0',
      mode: 'advisory',
      agents: Object.keys(this.agents),
      services: Object.keys(this.services)
    };
  }

  async buildDecisionContext(channelStrategy = {}) {
    const context = {
      channelStrategy,
      timestamp: new Date().toISOString(),
      signals: {},
      recommendations: [],
      experiments: []
    };

    // Existing trend intelligence
    if (this.agents.strategy?.analyzeTrends) {
      try {
        context.signals.trends =
          await this.agents.strategy.analyzeTrends();
      } catch (error) {
        this.logger.warn(`Trend analysis unavailable: ${error.message}`);
      }
    }

    // Existing channel-learning intelligence
    if (this.services.learning?.getSummary) {
      try {
        context.signals.learning =
          await this.services.learning.getSummary();
      } catch (error) {
        this.logger.warn(`Learning summary unavailable: ${error.message}`);
      }
    }

    // Existing analytics learning
    if (this.agents.analytics?.getLearningSummary) {
      try {
        context.signals.analytics =
          this.agents.analytics.getLearningSummary();
      } catch (error) {
        this.logger.warn(`Analytics learning unavailable: ${error.message}`);
      }
    }

    // Existing growth-experiment state
    if (this.services.experiments?.getSummary) {
      try {
        context.signals.experiments =
          await this.services.experiments.getSummary();
      } catch (error) {
        this.logger.warn(`Experiment summary unavailable: ${error.message}`);
      }
    }

    return context;
  }

  async recommend(strategy = {}, context = {}) {
    const recommendations = [];

    if (context.signals.trends) {
      recommendations.push({
        source: 'trend_research',
        type: 'content_timing',
        data: context.signals.trends
      });
    }

    if (context.signals.learning) {
      recommendations.push({
        source: 'channel_learning',
        type: 'historical_learning',
        data: context.signals.learning
      });
    }

    if (context.signals.analytics) {
      recommendations.push({
        source: 'analytics',
        type: 'performance_learning',
        data: context.signals.analytics
      });
    }

    if (context.signals.experiments) {
      recommendations.push({
        source: 'growth_experiments',
        type: 'active_experiments',
        data: context.signals.experiments
      });
    }

    return {
      strategy,
      recommendations,
      generatedAt: new Date().toISOString()
    };
  }

  async inspect(channelStrategy = {}) {
    const context = await this.buildDecisionContext(channelStrategy);
    const decision = await this.recommend(channelStrategy, context);

    return {
      status: 'ready',
      mode: 'advisory',
      context,
      decision
    };
  }
}

module.exports = { YouTubeOrchestrator };
